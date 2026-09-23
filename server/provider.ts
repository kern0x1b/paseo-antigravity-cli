import { randomUUID } from "node:crypto";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderContent,
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
import {
  DEFAULT_MODE_ID,
  MODES,
  buildCatalog,
  currentModels,
} from "./catalog";
import {
  STEP_AGENT_RESPONSE,
  STEP_STATE_DONE,
  STEP_TOOL,
  isInterrupted,
  type AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
  type AgyToolInfo,
  type AgyUsage,
} from "./protocol";
import { TranscriptStore } from "./transcript";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const PROVIDER_ID = "antigravity-cli";
const STDERR_TAIL = 20;
const SUMMARY_VALUE_LENGTH = 80;

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
  transcript: TranscriptStore | null;
  /** Rows published before `init` supplied a conversation id, drained into the store on init. */
  unpersisted: ProviderTimelineItem[];
  process: AgyProcess | null;
  /** Set when a selector changed but the CLI still runs with the previous launch flags. */
  needsRestart: boolean;
  systemPromptSent: boolean;
  turnCounter: number;
  currentTurnId: string | null;
  pendingTurns: string[];
  assistant: Map<number, string>;
  turnHadAssistantText: boolean;
  stderrTail: string[];
  interrupting: boolean;
  closing: boolean;
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
      for (const session of state.sessions.values()) {
        session.closing = true;
        if (session.process) running.push(session.process);
        session.process = null;
      }
      state.sessions.clear();
      listeners.clear();
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
    transcript: conversationId === null ? null : await TranscriptStore.load(conversationId),
    unpersisted: [],
    process: null,
    needsRestart: false,
    systemPromptSent: conversationId !== null,
    turnCounter: 0,
    currentTurnId: null,
    pendingTurns: [],
    assistant: new Map(),
    turnHadAssistantText: false,
    stderrTail: [],
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
  const turnId = `turn-${session.turnCounter}-${randomUUID().slice(0, 8)}`;

  publish(session, emit, {
    type: "user_message",
    id: `user:${turnId}`,
    text,
    clientMessageId: prompt.clientMessageId,
  });
  emit({
    type: "session.prompt_result",
    sessionId: session.sessionId,
    clientMessageId: prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "started" });

  session.pendingTurns.push(turnId);
  session.currentTurnId = turnId;
  session.turnHadAssistantText = false;
  session.assistant.clear();

  try {
    const process = ensureProcess(session, emit);
    process.writeTurn(buildOutgoingText(session, text));
    session.systemPromptSent = true;
  } catch (error) {
    session.pendingTurns = session.pendingTurns.filter((id) => id !== turnId);
    session.currentTurnId = session.pendingTurns.at(-1) ?? null;
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId,
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
  if (session.process?.running) return session.process;

  const process = new AgyProcess(
    {
      cwd: session.config.cwd,
      env: session.config.env,
      model: session.selection.model,
      mode: session.selection.mode,
      conversationId: session.conversationId ?? undefined,
      autoApprove: isAutoApprove(session),
      extraArgs: session.extraArgs,
      binary: session.agyPath,
    },
    {
      onEvent: (event) => handleAgyEvent(session, event, emit),
      onStderr: (line) => {
        session.stderrTail.push(line);
        if (session.stderrTail.length > STDERR_TAIL) session.stderrTail.shift();
        console.error(`[antigravity] ${line}`);
      },
      onExit: (info) => handleAgyExit(session, info, emit),
    },
  );

  session.process = process;
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
        session.transcript = new TranscriptStore(event.conversationId);
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

  if (step.step_type === STEP_AGENT_RESPONSE) {
    if (step.text_delta) {
      // text_delta is an incremental chunk, so accumulate to republish complete snapshots.
      session.assistant.set(
        step.step_index,
        (session.assistant.get(step.step_index) ?? "") + step.text_delta,
      );
    }
    const text = session.assistant.get(step.step_index);
    if (text && text.length > 0) {
      session.turnHadAssistantText = true;
      publish(session, emit, {
        type: "assistant_message",
        id: itemId(session, step.step_index, "msg"),
        text,
      });
    }
    return;
  }

  if (step.step_type === STEP_TOOL) {
    const callId = itemId(session, step.step_index, "tool");
    const name = step.tool_name ?? step.tool_info?.name ?? "tool";
    console.log(`[antigravity] tool ${name} ${step.state}`);
    const base = {
      type: "tool_call" as const,
      id: callId,
      callId,
      name,
      detail: mapToolDetail(name, step.tool_info, session.config.cwd),
      metadata: {
        stepIndex: step.step_index,
        ...(step.tool_info?.parameters ? { parameters: toJson(step.tool_info.parameters) } : {}),
      },
    };
    publish(
      session,
      emit,
      step.state === STEP_STATE_DONE
        ? { ...base, status: "completed", error: null }
        : { ...base, status: "running", error: null },
    );
    return;
  }

  // `user_input` is published by the provider with its clientMessageId, and `system_message`
  // carries no user-facing content, so neither becomes a timeline row.
}

function handleResult(session: Session, result: AgyResult, emit: Emit): void {
  const turnId = session.pendingTurns.shift() ?? null;
  session.currentTurnId = session.pendingTurns.at(-1) ?? null;
  console.log(
    `[antigravity] result status=${result.status} turns=${result.num_turns ?? "-"} text=${
      (result.response ?? "").length
    } chars${result.error ? ` error=${result.error}` : ""}`,
  );

  if (result.usage) {
    emit({
      type: "session.usage",
      sessionId: session.sessionId,
      turnId: turnId ?? undefined,
      usage: toProviderUsage(result.usage),
    });
  }

  if (turnId === null) {
    console.error(`[antigravity] ignoring a result with no active turn (${result.status})`);
    return;
  }

  if (result.status === "SUCCESS") {
    const response = result.response ?? "";
    // Safety net: agy answered without streaming any assistant text.
    if (!session.turnHadAssistantText && response.trim().length > 0) {
      publish(session, emit, {
        type: "assistant_message",
        id: `agy:result:${turnId}`,
        text: response,
      });
    }
    emit({ type: "session.turn", sessionId: session.sessionId, turnId, state: "completed" });
    return;
  }

  if (isInterrupted(result)) {
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId,
      state: "canceled",
      error: { message: "Interrupted" },
    });
    return;
  }

  emit({
    type: "session.turn",
    sessionId: session.sessionId,
    turnId,
    state: "failed",
    error: {
      message: result.error ?? `Antigravity reported ${result.status}`,
      code: result.status,
    },
  });
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
  session.currentTurnId = null;
  if (pending.length === 0) return;

  // agy writes its diagnostics to stderr, which is where an invalid model or a missing sign-in
  // shows up, so surface the tail rather than a bare exit code.
  const tail = session.stderrTail.slice(-3).join(" ");
  const detail =
    tail.length > 0
      ? tail
      : `Antigravity exited (code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""})`;

  for (const turnId of pending) {
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId,
      state: session.interrupting ? "canceled" : "failed",
      error: { message: detail, code: session.interrupting ? "interrupted" : "agy_exit" },
    });
  }
}

function publish(session: Session, emit: Emit, item: ProviderTimelineItem): void {
  if (session.transcript) session.transcript.upsert(item);
  else session.unpersisted.push(item);
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
  return [
    {
      type: "toggle",
      id: "autoApprove",
      label: "Auto-approve tools",
      description:
        "Passes --dangerously-skip-permissions. Without it, Antigravity denies tools that need approval in headless runs.",
      value: isAutoApprove(session),
    },
  ];
}

function isAutoApprove(session: Session): boolean {
  return session.settings.autoApprove !== false;
}

function requireSession(state: ConnectionState, sessionId: string): Session {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

function itemId(session: Session, stepIndex: number, kind: string): string {
  return `agy:${kind}:${session.currentTurnId ?? "idle"}:${stepIndex}`;
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

function mapToolDetail(
  name: string,
  info: AgyToolInfo | undefined,
  cwd: string,
): ProviderToolCallDetail {
  const parameters = info?.parameters ?? {};
  const output = info?.output;
  const text = (key: string): string | undefined => {
    const value = parameters[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const plain = (): ProviderToolCallDetail => ({
    type: "plain_text",
    label: name,
    text: output ?? summarizeParameters(parameters),
  });

  switch (name) {
    case "run_command": {
      const command = text("CommandLine");
      return command
        ? { type: "shell", command, cwd: text("Cwd") ?? cwd, output }
        : plain();
    }
    case "view_file":
    case "read_resource": {
      const filePath = text("AbsolutePath") ?? text("Path");
      return filePath ? { type: "read", filePath } : plain();
    }
    case "write_to_file": {
      const filePath = text("TargetFile") ?? text("AbsolutePath");
      return filePath
        ? { type: "write", filePath, content: text("CodeContent") ?? text("Content") }
        : plain();
    }
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file": {
      const filePath = text("TargetFile") ?? text("AbsolutePath");
      return filePath ? { type: "edit", filePath } : plain();
    }
    case "grep_search":
      return {
        type: "search",
        query: text("Query") ?? text("Pattern") ?? "",
        toolName: "grep",
        content: output,
      };
    case "find_by_name":
    case "list_dir":
      return {
        type: "search",
        query: text("Pattern") ?? text("DirectoryPath") ?? "",
        toolName: "glob",
        content: output,
      };
    case "search_web":
      return {
        type: "search",
        query: text("query") ?? text("Query") ?? "",
        toolName: "web_search",
        content: output,
      };
    case "read_url_content": {
      const url = text("Url") ?? text("URL");
      return url ? { type: "fetch", url, result: output } : plain();
    }
    case "invoke_subagent":
    case "define_subagent":
      return { type: "sub_agent", log: output ?? "", description: text("Description") };
    default:
      return plain();
  }
}

function summarizeParameters(parameters: Record<string, unknown>): string {
  const keys = Object.keys(parameters);
  if (keys.length === 0) return "";
  const parts = keys.slice(0, 4).map((key) => `${key}=${shorten(parameters[key])}`);
  return keys.length > 4 ? `${parts.join(", ")}, …` : parts.join(", ");
}

function shorten(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) return "undefined";
  const single = raw.replace(/\s+/g, " ");
  return single.length > SUMMARY_VALUE_LENGTH
    ? `${single.slice(0, SUMMARY_VALUE_LENGTH)}…`
    : single;
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
