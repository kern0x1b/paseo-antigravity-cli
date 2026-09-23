import { randomUUID } from "node:crypto";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderContent,
  type ProviderError,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderSetting,
  type ProviderTimelineItem,
  type ProviderToolCallDetail,
  type ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { AgyProcess } from "./agy";
import { readToolPermission } from "./agysettings";
import {
  isObservedTool,
  isSnapshotTool,
  readSnapshot,
  snapshotTarget,
  type FileSnapshot,
} from "./edits";
import {
  DEFAULT_MODE_ID,
  MODES,
  buildCatalog,
  catalogCacheKey,
  currentModels,
  invalidateCatalogCache,
} from "./catalog";
import {
  STEP_AGENT_RESPONSE,
  STEP_STATE_DONE,
  STEP_TOOL,
  isInterrupted,
  parseAgyErrorLine,
  type AgyErrorReport,
  type AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
  type AgyUsage,
} from "./protocol";
import { TranscriptStore } from "./transcript";
import { hasEditContent, mapToolDetail, snapshotDiff } from "./tools";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const PROVIDER_ID = "antigravity-cli";
const STDERR_TAIL = 20;
/** Whole files remembered per session for diffing, newest last. */
const OBSERVED_LIMIT = 32;

/**
 * A transient Antigravity outage. Captured verbatim from a real one as
 * `UNAVAILABLE (code 503): The service is currently unavailable.` in the failed result's `error`
 * (fixtures/05-unavailable.ndjson). The check is deliberately narrow: widening it would label a
 * permanent failure such as `model does-not-exist is not recognized` as worth retrying.
 */
const UNAVAILABLE_PATTERN = /\bUNAVAILABLE\b|\b503\b/;

/**
 * `prompt.steer` is deliberately absent: a line written to agy stdin while a turn is running is
 * queued into a following turn rather than applied to the running one, so Paseo replaces the
 * active turn instead. `permission` is absent because agy resolves approvals internally and
 * cannot surface them over this protocol.
 *
 * `permission.tool_policy` is accepted because `session.open` is rejected outright when the
 * config carries a `toolPolicy` and the capability is missing. Preapproved MCP tools cannot be
 * forwarded to agy, which reads its own rules from settings.json; that is covered by the MCP
 * notice emitted on session open.
 */
const CAPABILITIES = [
  "prompt.message",
  "session.configure",
  "session.persistence",
  "permission.tool_policy",
] as const;

export function createProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: "Antigravity",
    description: "Run, monitor, and steer Antigravity sessions from Paseo",
    icon: "icon.svg",
    async getCatalogCacheKey(options) {
      // Catalog inputs carry no providerOptions, so a per-session `agyPath` cannot reach the
      // catalog; the key follows the resolved binary, its build, and the environment override.
      // `force` is the caller asking for a refresh, which the in-process cache must not answer
      // with the list it already has.
      if (options.force) invalidateCatalogCache();
      return catalogCacheKey();
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Antigravity provider requires provider protocol version 1");
      }
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

interface Session {
  readonly sessionId: string;
  readonly config: ProviderSessionConfig;
  readonly agyPath?: string;
  readonly extraArgs?: readonly string[];
  settings: Record<string, JsonValue>;
  selection: { model?: string; mode?: string };
  conversationId: string | null;
  /** `persist: false` keeps the conversation resumable but writes no timeline to disk. */
  readonly persist: boolean;
  transcript: TranscriptStore | null;
  /** Rows published before `init` supplied a conversation id, drained into the store on init. */
  unpersisted: ProviderTimelineItem[];
  process: AgyProcess | null;
  /** Set when a selector changed but the CLI still runs with the previous launch flags. */
  needsRestart: boolean;
  systemPromptSent: boolean;
  turnCounter: number;
  /** Turns written to agy that have not reported a result yet, oldest first. */
  pendingTurns: PendingTurn[];
  /**
   * The content of files the plugin has been shown, newest last. agy applies an edit *before* it
   * reports the step as ACTIVE (probed: the rewritten file is on disk when the ACTIVE line
   * arrives), so the step's own snapshot is already the state after the edit; what the plugin saw
   * earlier is then the only usable "before".
   */
  observed: Map<string, Promise<FileSnapshot | null>>;
  stderrTail: string[];
  /** Structured `AGY_ERROR` line of the current process, if it printed one. */
  agyError: AgyErrorReport | null;
  interrupting: boolean;
  closing: boolean;
}

/**
 * agy runs queued stdin lines in order, so the *oldest* pending turn owns every incoming event:
 * a prompt sent while another turn is streaming must not relabel that turn's rows or clear the
 * text it has already accumulated.
 */
interface PendingTurn {
  readonly turnId: string;
  /** Incremental assistant text per step_index, accumulated into complete snapshots. */
  readonly assistant: Map<number, string>;
  /** Tool rows published as `running` and not yet complete, keyed by call id. */
  readonly tools: Map<string, OpenToolCall>;
  /** The target file as it was when a snapshot tool started, keyed by call id. */
  readonly snapshots: Map<string, Promise<FileSnapshot | null>>;
  hadAssistantText: boolean;
  /**
   * `input_tokens` of the last agent_response step that reported usage: the size the model's
   * context had reached, as opposed to the result's total across every step of the turn.
   */
  contextInputTokens?: number;
}

/** The fields of a tool row, kept so a call left open can be republished with a terminal status. */
interface OpenToolCall {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly detail: ProviderToolCallDetail;
  readonly metadata: Record<string, JsonValue>;
}

/** The error a failed turn reports, and whether retrying is likely to help. */
interface TurnFailure {
  error: ProviderError;
  retryable: boolean;
}

interface ConnectionState {
  capabilities: readonly ProviderCapability[];
  sessions: Map<string, Session>;
}

type Emit = (event: ProviderEvent) => void;

function createConnection(capabilities: readonly ProviderCapability[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const state: ConnectionState = { capabilities, sessions: new Map() };
  let closed = false;

  const emit: Emit = (event) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Antigravity provider connection is closed");
      console.log(`[antigravity] input ${describeInput(input)}`);
      validateAdmission(input, state);
      await dispatch(input, state, emit);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const running: AgyProcess[] = [];
      const flushing: Promise<void>[] = [];
      for (const session of state.sessions.values()) {
        session.closing = true;
        if (session.process) running.push(session.process);
        session.process = null;
        if (session.transcript) flushing.push(session.transcript.flush());
      }
      state.sessions.clear();
      listeners.clear();
      // The rows of the last turn are still inside the debounce window, so flushing before the
      // processes are disposed is what lets a reload replay the answer that just finished.
      await Promise.all(flushing);
      await Promise.all(running.map((process) => process.dispose()));
    },
  };
}

function validateAdmission(input: ProviderInput, state: ConnectionState): void {
  if (input.type === "session.open") {
    if (state.sessions.has(input.sessionId)) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!("sessionId" in input)) {
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!state.sessions.has(input.sessionId)) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
  requireProviderCapabilities(state.capabilities, input);
}

async function dispatch(input: ProviderInput, state: ConnectionState, emit: Emit): Promise<void> {
  switch (input.type) {
    case "catalog":
      emit({ type: "catalog", requestId: input.requestId, catalog: await buildCatalog() });
      return;
    case "session.open":
      await openSession(input, state, emit);
      return;
    case "session.prompt":
      await promptSession(input, state, emit);
      return;
    case "session.interrupt":
      await interruptSession(input, state, emit);
      return;
    case "session.configure":
      await configureSession(input, state, emit);
      return;
    case "session.close":
      await closeSession(input, state, emit);
      return;
    default:
      throw new Error(`Unsupported provider input: ${(input as { type: string }).type}`);
  }
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const config = input.config;
  const conversationId = readConversationId(input.persistence);
  const options = readProviderOptions(config);
  const persist = config.persist !== false;

  const session: Session = {
    sessionId: input.sessionId,
    config,
    agyPath: options.agyPath,
    extraArgs: options.extraArgs,
    settings: { ...config.settings },
    selection: {
      model: config.model,
      mode: config.mode ?? DEFAULT_MODE_ID,
    },
    conversationId,
    persist,
    transcript:
      persist && conversationId !== null ? await TranscriptStore.load(conversationId) : null,
    unpersisted: [],
    process: null,
    needsRestart: false,
    systemPromptSent: conversationId !== null,
    turnCounter: 0,
    pendingTurns: [],
    observed: new Map(),
    stderrTail: [],
    agyError: null,
    interrupting: false,
    closing: false,
  };
  state.sessions.set(input.sessionId, session);

  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: state.capabilities,
    restoration: "core",
    persistence: persistenceFor(conversationId),
    title: config.title,
    cwd: config.cwd,
  });
  emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });

  if (Object.keys(config.mcpServers).length > 0) {
    emitNotice(
      session,
      emit,
      "mcp-unsupported",
      "warning",
      "MCP servers are not applied",
      "Antigravity reads MCP servers from ~/.gemini/config/mcp_config.json and .agents/mcp_config.json. Add them there, or run `agy mcp add`.",
    );
  }
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    emitNotice(
      session,
      emit,
      "system-prompt-preamble",
      "info",
      "System prompt sent as a preamble",
      "Antigravity has no system-prompt flag, so it is prepended to the first message of the conversation.",
    );
  }

  if (input.history === "replay" && session.transcript) {
    for (const item of session.transcript.list()) {
      emit({ type: "timeline.item", sessionId: session.sessionId, item });
    }
  }

  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const { prompt } = input;

  await applyPendingRestart(session);

  // `prompt.command` and `prompt.steer` are not advertised, so a prompt is always a message.
  const text = prompt.input.type === "message" ? renderContent(prompt.input.content) : "";
  if (text.trim().length === 0) {
    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: prompt.clientMessageId,
      result: {
        type: "failed",
        error: { message: "Antigravity requires a non-empty text prompt", code: "empty_prompt" },
      },
    });
    return;
  }

  session.turnCounter += 1;
  const turn: PendingTurn = {
    turnId: `turn-${session.turnCounter}-${randomUUID().slice(0, 8)}`,
    assistant: new Map(),
    tools: new Map(),
    snapshots: new Map(),
    hadAssistantText: false,
  };

  publish(session, emit, {
    type: "user_message",
    id: `user:${turn.turnId}`,
    text,
    clientMessageId: prompt.clientMessageId,
  });
  emit({
    type: "session.prompt_result",
    sessionId: session.sessionId,
    clientMessageId: prompt.clientMessageId,
    result: { type: "turn", turnId: turn.turnId },
  });
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "started" });

  try {
    // Picking the process first: replacing a CLI whose stdin died settles the turns that CLI still
    // owed, and this turn must not be counted among them.
    const process = ensureProcess(session, emit);
    session.pendingTurns.push(turn);
    await process.writeTurn(buildOutgoingText(session, text));
    session.systemPromptSent = true;
  } catch (error) {
    session.pendingTurns = session.pendingTurns.filter((pending) => pending !== turn);
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: "failed",
      error: { message: describe(error), code: "agy_launch_failed" },
    });
  }
}

async function interruptSession(
  input: Extract<ProviderInput, { type: "session.interrupt" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const process = session.process;
  if (process?.running) {
    session.interrupting = true;
    try {
      await process.interrupt();
    } finally {
      session.interrupting = false;
    }
  }
  // agy normally reports `result.error = "interrupted"` before exiting, which resolves the turn.
  // If it died without one, the exit handler cancels whatever is still pending.
  emit({ type: "request.completed", requestId: input.requestId });
}

async function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const changes = input.changes;

  if (changes.model !== undefined) {
    session.selection.model = changes.model === null ? undefined : changes.model;
  }
  if (changes.mode !== undefined) {
    session.selection.mode = changes.mode === null ? undefined : changes.mode;
  }
  if (changes.settings) {
    session.settings = { ...session.settings, ...changes.settings };
  }

  // agy fixes the model, mode, and approval flags at launch, so a change is applied by restarting
  // the CLI. That restart is deferred to the start of the next turn: killing the process here
  // would abort an answer that is already streaming just because a selector moved.
  if (session.process?.running) session.needsRestart = true;

  emit({ type: "session.config", sessionId: session.sessionId, config: configState(session) });
  emit({ type: "request.completed", requestId: input.requestId });
}

/**
 * Restarts the CLI so newly selected launch flags take effect. The Antigravity conversation id is
 * passed back through `--conversation`, so the history survives the restart.
 */
async function applyPendingRestart(session: Session): Promise<void> {
  if (!session.needsRestart || session.pendingTurns.length > 0) return;
  session.needsRestart = false;

  const process = session.process;
  if (!process) return;
  session.process = null;
  console.log("[antigravity] restarting the CLI with updated settings");
  await process.dispose();
}

async function closeSession(
  input: Extract<ProviderInput, { type: "session.close" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  session.closing = true;
  const process = session.process;
  session.process = null;
  state.sessions.delete(input.sessionId);

  await session.transcript?.flush();
  if (process) await process.dispose();

  emit({ type: "session.closed", sessionId: input.sessionId });
  emit({ type: "request.completed", requestId: input.requestId });
}

function ensureProcess(session: Session, emit: Emit): AgyProcess {
  const current = session.process;
  if (current?.running) {
    if (current.acceptsInput) return current;
    // A CLI that lost its stdin can neither take this turn nor finish the ones it still owes, so
    // settle those turns and replace it. Its own exit is ignored below: it no longer owns the
    // session, and failing the new process's turns from it would be wrong.
    handleAgyExit(session, { code: null, signal: null }, emit);
    void current.dispose();
  }

  const process = new AgyProcess(
    {
      cwd: session.config.cwd,
      env: session.config.env,
      model: session.selection.model,
      mode: session.selection.mode,
      conversationId: session.conversationId ?? undefined,
      skipPermissions: approvalPolicy(session) === "skip",
      extraArgs: session.extraArgs,
      binary: session.agyPath,
    },
    {
      // A replaced CLI keeps writing events and stderr until it dies; none of it belongs to the
      // turns of the process that replaced it.
      onEvent: (event) => {
        if (session.process !== process) return;
        handleAgyEvent(session, event, emit);
      },
      onStderr: (line) => {
        if (session.process !== process) return;
        session.stderrTail.push(line);
        if (session.stderrTail.length > STDERR_TAIL) session.stderrTail.shift();
        session.agyError = parseAgyErrorLine(line) ?? session.agyError;
        console.error(`[antigravity] ${line}`);
      },
      onExit: (info) => {
        if (session.process !== process) return;
        handleAgyExit(session, info, emit);
      },
    },
  );

  session.process = process;
  // The tail explains *this* process's failure; leftovers from a previous launch would be quoted
  // as if they came from the run that just died. The same holds for the structured error line.
  session.stderrTail = [];
  session.agyError = null;
  process.start();
  return process;
}

function handleAgyEvent(session: Session, event: AgyEvent, emit: Emit): void {
  switch (event.kind) {
    case "init":
      console.log(
        `[antigravity] init conversation=${event.conversationId} tools=${event.tools.length}`,
      );
      if (event.conversationId !== session.conversationId) {
        session.conversationId = event.conversationId;
        // A new conversation starts empty; a resumed one was loaded during session.open.
        session.transcript = session.persist ? new TranscriptStore(event.conversationId) : null;
      }
      if (session.transcript && session.unpersisted.length > 0) {
        // The user's first message is published before the process exists, so it is captured here.
        for (const item of session.unpersisted) session.transcript.upsert(item);
        session.unpersisted = [];
      }
      emit({
        type: "session.persistence",
        sessionId: session.sessionId,
        persistence: persistenceFor(event.conversationId),
      });
      return;
    case "step_update":
      handleStepUpdate(session, event.step, emit);
      return;
    case "result":
      handleResult(session, event.result, emit);
      return;
    default:
      return;
  }
}

function handleStepUpdate(session: Session, step: AgyStepUpdate, emit: Emit): void {
  console.log(
    `[antigravity] step idx=${step.step_index} ${step.state} ${step.step_type}` +
      `${step.text_delta ? ` delta=${step.text_delta.length}` : " (no text)"}` +
      `${step.tool_name ? ` tool=${step.tool_name}` : ""}`,
  );

  const turn = session.pendingTurns[0];

  if (step.step_type === STEP_AGENT_RESPONSE) {
    if (!turn) {
      console.error(
        `[antigravity] dropping an agent_response step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    if (step.text_delta) {
      // text_delta is an incremental chunk, so accumulate to republish complete snapshots.
      turn.assistant.set(
        step.step_index,
        (turn.assistant.get(step.step_index) ?? "") + step.text_delta,
      );
    }
    if (step.usage?.input_tokens !== undefined) turn.contextInputTokens = step.usage.input_tokens;
    const text = turn.assistant.get(step.step_index);
    if (text && text.length > 0) {
      turn.hadAssistantText = true;
      publish(session, emit, {
        type: "assistant_message",
        id: itemId(turn, step.step_index, "msg"),
        text,
      });
    }
    return;
  }

  if (step.step_type === STEP_TOOL) {
    if (!turn) {
      console.error(
        `[antigravity] dropping a tool step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    const callId = itemId(turn, step.step_index, "tool");
    const name = step.tool_name ?? step.tool_info?.name ?? "tool";
    console.log(`[antigravity] tool ${name} ${step.state}`);
    const detail = mapToolDetail(name, step.tool_info, session.config.cwd);
    const tool: OpenToolCall = {
      id: callId,
      callId,
      name,
      detail,
      metadata: {
        stepIndex: step.step_index,
        ...(step.tool_info?.parameters ? { parameters: toJson(step.tool_info.parameters) } : {}),
      },
    };
    // The stream names the file but not the change, so the file itself is the only source for a
    // diff: snapshot it before the call runs and compare once the call reports DONE. Parameters
    // that already carry the content win, and a file that cannot be read leaves the row as is.
    const parameters = step.tool_info?.parameters;
    const snapshotPath = snapshotTarget(parameters);
    // A read tool is the one chance to see the file as it was before a later edit changes it, and
    // only as the step *arrives*: re-reading when the step finishes would race whatever changed
    // the file in between and store the result as if the step had shown it.
    if (
      snapshotPath &&
      isObservedTool(name) &&
      (step.state !== STEP_STATE_DONE || !session.observed.has(snapshotPath))
    ) {
      rememberObserved(session, snapshotPath);
    }
    const target = isSnapshotTool(name) && !hasEditContent(detail) ? snapshotPath : null;

    if (step.state === STEP_STATE_DONE) {
      turn.tools.delete(callId);
      const before = turn.snapshots.get(callId);
      turn.snapshots.delete(callId);
      publish(session, emit, { type: "tool_call", ...tool, status: "completed", error: null });
      if (target && before) void publishEditDiff(session, emit, tool, target, before);
      return;
    }
    turn.tools.set(callId, tool);
    if (target) turn.snapshots.set(callId, readSnapshot(target));
    publish(session, emit, { type: "tool_call", ...tool, status: "running", error: null });
    return;
  }

  // `user_input` is published by the provider with its clientMessageId, and `system_message`
  // carries no user-facing content, so neither becomes a timeline row.
}

function handleResult(session: Session, result: AgyResult, emit: Emit): void {
  const turn = session.pendingTurns.shift() ?? null;
  console.log(
    `[antigravity] result status=${result.status} turns=${result.num_turns ?? "-"} text=${
      (result.response ?? "").length
    } chars${result.error ? ` error=${result.error}` : ""}`,
  );

  // `result.usage.input_tokens` totals every step of the turn, so on its own it overstates what
  // the model is holding; the last step's own count is the context occupancy.
  const contextWindowUsedTokens = turn?.contextInputTokens;
  if (result.usage || contextWindowUsedTokens !== undefined) {
    emit({
      type: "session.usage",
      sessionId: session.sessionId,
      turnId: turn?.turnId,
      usage: {
        ...(result.usage ? toProviderUsage(result.usage) : {}),
        ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
      },
    });
  }

  if (turn === null) {
    console.error(`[antigravity] ignoring a result with no active turn (${result.status})`);
    return;
  }

  if (result.status === "SUCCESS") {
    const response = result.response ?? "";
    // Safety net: agy answered without streaming any assistant text.
    if (!turn.hadAssistantText && response.trim().length > 0) {
      publish(session, emit, {
        type: "assistant_message",
        id: `agy:result:${turn.turnId}`,
        text: response,
      });
    }
    emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
    return;
  }

  if (isInterrupted(result)) {
    finalizeToolCalls(session, emit, turn, { status: "canceled" });
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: "canceled",
      error: { message: "Interrupted" },
    });
    return;
  }

  const { error, retryable } = turnFailure(session, {
    message: result.error ?? `Antigravity reported ${result.status}`,
    code: result.status,
  });
  finalizeToolCalls(session, emit, turn, { status: "failed", error });
  emit({
    type: "session.turn",
    sessionId: session.sessionId,
    turnId: turn.turnId,
    state: "failed",
    error,
  });
  if (retryable) emitUnavailableNotice(session, emit);
}

function handleAgyExit(
  session: Session,
  info: { code: number | null; signal: NodeJS.Signals | null },
  emit: Emit,
): void {
  session.process = null;
  if (session.closing) return;

  const pending = session.pendingTurns;
  session.pendingTurns = [];
  if (pending.length === 0) return;

  // agy writes its diagnostics to stderr, which is where an invalid model or a missing sign-in
  // shows up, so surface the tail rather than a bare exit code.
  const tail = session.stderrTail.slice(-3).join(" ");
  const detail =
    tail.length > 0
      ? tail
      : `Antigravity exited (code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""})`;
  // A canceled turn is not an API failure, so the structured error line of the process that
  // happened to be signalled must not be reported as its cause.
  const failure: TurnFailure = session.interrupting
    ? { error: { message: detail, code: "interrupted" }, retryable: false }
    : turnFailure(session, { message: detail, code: "agy_exit" });

  for (const turn of pending) {
    finalizeToolCalls(
      session,
      emit,
      turn,
      session.interrupting ? { status: "canceled" } : { status: "failed", error: failure.error },
    );
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: session.interrupting ? "canceled" : "failed",
      error: failure.error,
    });
  }
  if (failure.retryable) emitUnavailableNotice(session, emit);
}

/**
 * The error a failed turn reports. A structured `AGY_ERROR` line is canonical when the process
 * printed one; otherwise a transient outage is named `unavailable` so a retry is obvious, and any
 * other failure keeps the status agy reported or the exit-path code.
 */
function turnFailure(session: Session, fallback: { message: string; code: string }): TurnFailure {
  const report = session.agyError;
  if (report) {
    const error: ProviderError = {
      message: report.short_error ?? fallback.message,
      code: report.status ?? fallback.code,
      diagnostic: report.raw,
    };
    const retryable =
      report.retryable === true || UNAVAILABLE_PATTERN.test(`${error.code ?? ""} ${error.message}`);
    return { error, retryable };
  }
  if (UNAVAILABLE_PATTERN.test(fallback.message)) {
    return { error: { message: fallback.message, code: "unavailable" }, retryable: true };
  }
  return { error: { message: fallback.message, code: fallback.code }, retryable: false };
}

function emitUnavailableNotice(session: Session, emit: Emit): void {
  emitNotice(
    session,
    emit,
    "agy-unavailable",
    "warning",
    "Antigravity is temporarily unavailable",
    "The Antigravity service reported that it is temporarily unavailable. Retry the prompt in a moment; this usually clears on its own.",
  );
}

/**
 * A tool row published as `running` would otherwise stay running forever once its turn ends, so
 * every call left open is republished with a terminal status under the same id.
 */
function finalizeToolCalls(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  terminal: { status: "canceled" } | { status: "failed"; error: ProviderError },
): void {
  if (turn.tools.size === 0) return;
  for (const tool of turn.tools.values()) {
    publish(
      session,
      emit,
      terminal.status === "canceled"
        ? { type: "tool_call", ...tool, status: "canceled", error: null }
        : { type: "tool_call", ...tool, status: "failed", error: toErrorJson(terminal.error) },
    );
  }
  turn.tools.clear();
}

/**
 * Keeps the newest content the plugin was shown for a path, bounded so a long session cannot
 * accumulate whole files. A caller that already holds the content passes it rather than paying
 * for a second read.
 */
function rememberObserved(session: Session, path: string, snapshot?: FileSnapshot): void {
  session.observed.delete(path);
  session.observed.set(path, snapshot ? Promise.resolve(snapshot) : readSnapshot(path));
  if (session.observed.size > OBSERVED_LIMIT) {
    const oldest = session.observed.keys().next().value;
    if (oldest !== undefined) session.observed.delete(oldest);
  }
}

/**
 * Republishes a completed tool row with a diff once both snapshots of its target are in hand.
 * Nothing waits on it: the row the stream justified is already on screen, and Paseo replaces a
 * row by id, so a slow read can neither delay the turn nor reorder the rows after it.
 */
async function publishEditDiff(
  session: Session,
  emit: Emit,
  tool: OpenToolCall,
  path: string,
  before: Promise<FileSnapshot | null>,
): Promise<void> {
  try {
    const [active, current] = await Promise.all([before, readSnapshot(path)]);
    if (current === null || !current.exists) return;
    // The step's own snapshot is the "before" whenever the file still held its previous content
    // when the step arrived. When it already matches, the edit had applied before ACTIVE reached
    // the plugin, and the last content the plugin was shown is what changed.
    const observed = (await session.observed.get(path)) ?? null;
    const previous = active !== null && active.text !== current.text ? active : (observed ?? active);
    if (previous === null) return;
    if (previous.exists && previous.text === current.text) return;
    if (session.closing) return;

    // write_to_file creating a file has no earlier state to diff against, so the row shows what
    // the file now holds. Anything else is described as the edit it was.
    let detail: ProviderToolCallDetail;
    if (!previous.exists && tool.name === "write_to_file") {
      detail = { type: "write", filePath: path, content: current.text };
    } else {
      const unifiedDiff = snapshotDiff(path, previous.text, current.text, session.config.cwd);
      if (unifiedDiff === null) return;
      detail = { type: "edit", filePath: path, unifiedDiff };
    }

    publish(session, emit, { type: "tool_call", ...tool, detail, status: "completed", error: null });
    rememberObserved(session, path, current);
  } catch (error) {
    console.error(
      `[antigravity] could not diff ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function publish(session: Session, emit: Emit, item: ProviderTimelineItem): void {
  if (session.transcript) session.transcript.upsert(item);
  else if (session.persist) session.unpersisted.push(item);
  emit({ type: "timeline.item", sessionId: session.sessionId, item });
}

function emitNotice(
  session: Session,
  emit: Emit,
  id: string,
  severity: "info" | "warning" | "error",
  title: string,
  description: string,
): void {
  emit({
    type: "session.notice",
    sessionId: session.sessionId,
    notice: { id, severity, title, description },
  });
}

function configState(session: Session): ProviderConfigState {
  return {
    model: session.selection.model,
    mode: session.selection.mode ?? DEFAULT_MODE_ID,
    models: currentModels(),
    modes: MODES,
    thinkingOptions: [],
    settings: buildSettings(session),
  };
}

function buildSettings(session: Session): readonly ProviderSetting[] {
  const policy = approvalPolicy(session);
  // Antigravity decides through its own setting unless the user overrides it here, so the row
  // names that value rather than guessing at what a headless run will do.
  const permission = readToolPermission() ?? "unknown";
  return [
    {
      type: "select",
      id: "approvalPolicy",
      label: "Tool approval",
      description:
        policy === "skip"
          ? `Every tool runs without asking (--dangerously-skip-permissions), overriding Antigravity's toolPermission (${permission}).`
          : `Antigravity decides, using its own toolPermission setting (${permission}).`,
      value: policy,
      options: [
        { label: "Use Antigravity setting", value: "agy" },
        { label: "Skip all permissions", value: "skip" },
      ],
    },
  ];
}

/**
 * `agy` defers approval to Antigravity's own `toolPermission` setting and passes no flag; `skip`
 * passes --dangerously-skip-permissions. A session persisted before this select existed carries
 * the removed `autoApprove` toggle, which was on by default and meant the same as `skip`.
 */
function approvalPolicy(session: Session): "agy" | "skip" {
  const value = session.settings.approvalPolicy;
  if (value === "agy" || value === "skip") return value;
  return session.settings.autoApprove === true ? "skip" : "agy";
}

function requireSession(state: ConnectionState, sessionId: string): Session {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

function itemId(turn: PendingTurn, stepIndex: number, kind: string): string {
  return `agy:${kind}:${turn.turnId}:${stepIndex}`;
}

function toErrorJson(error: ProviderError): JsonValue {
  return {
    message: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.diagnostic !== undefined ? { diagnostic: error.diagnostic } : {}),
  };
}

function persistenceFor(conversationId: string | null): ProviderPersistence {
  return { version: 1, data: { conversationId } };
}

function readConversationId(persistence: ProviderPersistence | undefined): string | null {
  if (!persistence || persistence.version !== 1) return null;
  const data = persistence.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, JsonValue>).conversationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readProviderOptions(config: ProviderSessionConfig): {
  agyPath?: string;
  extraArgs?: readonly string[];
} {
  const options = config.providerOptions ?? {};
  const rawPath = options.agyPath;
  const rawArgs = options.extraArgs;
  return {
    agyPath: typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath : undefined,
    extraArgs: Array.isArray(rawArgs)
      ? rawArgs.filter((arg): arg is string => typeof arg === "string")
      : undefined,
  };
}

/** Antigravity has no system-prompt flag, so it is prepended to the first turn of a conversation. */
function buildOutgoingText(session: Session, text: string): string {
  if (session.systemPromptSent) return text;
  const systemPrompt = session.config.systemPrompt?.trim();
  if (!systemPrompt) return text;
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${text}`;
}

function renderContent(content: readonly ProviderContent[]): string {
  return content
    .map(renderPart)
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function renderPart(part: ProviderContent): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return "[an image was omitted: this plugin does not enable Antigravity image input]";
    case "uploaded_file":
      return `[uploaded file: ${part.path}]`;
    case "review":
      return renderReview(part);
    case "forge_change_request":
    case "forge_issue":
    case "github_pr":
    case "github_issue": {
      const header = `[${part.title}](${part.url})`;
      return part.body ? `${header}\n\n${part.body}` : header;
    }
    default:
      return "";
  }
}

function renderReview(part: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [`[code review · ${part.mode}] ${part.cwd}`];
  for (const comment of part.comments) {
    lines.push(`\n${comment.filePath}:${comment.lineNumber} (${comment.side})\n${comment.body}`);
  }
  return lines.join("\n");
}

function toProviderUsage(usage: AgyUsage): ProviderUsage {
  const outputTokens = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_tokens,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };
}

function toJson(value: Record<string, unknown>): JsonValue {
  return structuredClone(value) as JsonValue;
}

/**
 * Daemon-side trace of protocol traffic. Prompt and system-prompt contents are reduced to lengths
 * because the retained plugin log tail is readable by anyone connected to this daemon.
 */
function describeInput(input: ProviderInput): string {
  switch (input.type) {
    case "catalog":
      return `catalog cwd=${input.cwd ?? "-"}`;
    case "sessions":
      return `sessions query=${input.query ?? "-"}`;
    case "session.open":
      return [
        "session.open",
        `session=${input.sessionId}`,
        `cwd=${input.config.cwd}`,
        `model=${input.config.model ?? "-"}`,
        `mode=${input.config.mode ?? "-"}`,
        `mcpServers=${Object.keys(input.config.mcpServers).length}`,
        `toolPolicy=${input.config.toolPolicy ? input.config.toolPolicy.preapproved.length : 0}`,
        `history=${input.history}`,
        `resume=${input.persistence ? "yes" : "no"}`,
        `systemPrompt=${input.config.systemPrompt?.length ?? 0}chars`,
        `settings=${JSON.stringify(input.config.settings)}`,
      ].join(" ");
    case "session.prompt":
      return [
        "session.prompt",
        `session=${input.sessionId}`,
        `delivery=${input.prompt.delivery}`,
        `kind=${input.prompt.input.type}`,
        `parts=${input.prompt.input.type === "message" ? input.prompt.input.content.length : 0}`,
        `text=${input.prompt.input.type === "message" ? renderContent(input.prompt.input.content).length : 0}chars`,
      ].join(" ");
    case "session.configure":
      return `session.configure session=${input.sessionId} changes=${JSON.stringify(input.changes)}`;
    case "session.interrupt":
      return `session.interrupt session=${input.sessionId}`;
    case "session.close":
      return `session.close session=${input.sessionId}`;
    default:
      return input.type;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
