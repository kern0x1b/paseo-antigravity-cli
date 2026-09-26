/**
 * What a session, a turn and a connection are, and the few helpers everything else shares. Nothing
 * here does I/O.
 */

import { randomUUID } from "node:crypto";
import type {
  ProviderCapability,
  ProviderError,
  ProviderEvent,
  ProviderSessionConfig,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { AgyProcess } from "./agy";
import type { FileSnapshot } from "./edits";
import type { JsonValue } from "./json";
import type { AgyErrorReport } from "./protocol";
import type { SubagentTranscript, TranscriptEntry } from "./subagents";
import type { TranscriptTailer } from "./tail";
import type { Timing } from "./timing";
import type { TranscriptStore } from "./transcript";

/**
 * The sessions that are open, across every connection of this plugin process: what a sweep of the
 * plugin's own files has to leave alone. A session belongs to the connection that opened it, but
 * the files it wrote belong to the process.
 */
export const liveSessions = new Set<string>();

export interface Session {
  readonly sessionId: string;
  readonly timing: Timing;
  readonly config: ProviderSessionConfig;
  readonly agyPath?: string;
  readonly extraArgs?: readonly string[];
  /** Absolute, existing directories from `providerOptions.addDirs`, passed as extra --add-dir. */
  readonly addDirs: readonly string[];
  settings: Record<string, JsonValue>;
  /**
   * The composer's selectors. `model` and `thinkingOption` are kept as they were chosen — a
   * persisted full slug such as `gemini-3.8-flash-high` stays itself — and are resolved together
   * into the `--model` slug at launch (`resolveThinking`).
   */
  selection: { model?: string; mode?: string; thinkingOption?: string };
  conversationId: string | null;
  /** `persist: false` keeps the conversation resumable but writes no timeline to disk. */
  readonly persist: boolean;
  transcript: TranscriptStore | null;
  /** Rows published before `init` supplied a conversation id, drained into the store on init. */
  unpersisted: ProviderTimelineItem[];
  process: AgyProcess | null;
  /** Set when a selector changed but the CLI still runs with the previous launch flags. */
  needsRestart: boolean;
  /** The one schema file this session's `--json-schema` points at. */
  readonly schemaPath: string;
  /**
   * What the *next* launch must carry. `--json-schema` and `--disable-slash-commands` are fixed at
   * launch, so a turn that needs a different profile replaces the CLI first.
   */
  launchPending: LaunchProfile;
  /** What the running CLI was actually launched with. */
  launchActive: LaunchProfile;
  /** Extra `--add-dir` holding attached images; null when the folder could not be created. */
  readonly attachmentsDir: string | null;
  /** Number of images written for this session, so filenames stay unique within it. */
  attachmentCount: number;
  /**
   * Where the session's private MCP folder stands: `applied` when it holds the servers and is
   * handed to the CLI, `error` when the last attempt to write it failed and reported why, and
   * `released` when there is none (or should be none).
   */
  mcp: "applied" | "released" | "error";
  /**
   * Names the composer was shown as plugin-expanded when this session opened. A command the user
   * picks from that list is served from a fresh read of the same roots; this set is what tells a
   * name that has since disappeared from a name the CLI expands itself.
   */
  publishedSkills: Set<string>;
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
  /**
   * Rows published for `invoke_subagent` steps, keyed by call id and kept past the turn that
   * published them: a subagent row outlives its turn, because the child it names is still running
   * after the parent's step is DONE and may still be running when the turn ends.
   */
  subagents: Map<string, SubagentRow>;
  /** Children whose transcripts are being followed, keyed by the row that spawned them. */
  follows: Map<string, ChildFollow>;
  /**
   * Every child session this parent opened, in the order they opened, whether it is being followed
   * or was re-opened by a replay for a child that had already finished. A replay leaves no tailer
   * behind it, so this set is the only record that such a child exists and closes with its parent.
   */
  childSessions: Set<string>;
  stderrTail: string[];
  /** Structured `AGY_ERROR` line of the current process, if it printed one. */
  agyError: AgyErrorReport | null;
  interrupting: boolean;
  /** Counts the interrupts received, so a prompt can tell that it was stopped while it was prepared. */
  interruptEpoch: number;
  /** Prompts are prepared one at a time, in the order they arrived. */
  promptChain: Promise<void>;
  closing: boolean;
  /**
   * A CLI whose stream a background task holds (see `backfill.ts`) and whose turn was settled from
   * the conversation transcript instead. It is kept alive — the task it holds is often a test run
   * the model is waiting for, or a dev server the answer just told the user about, and when a task
   * ends agy carries the conversation on in this same process — but it can never take another turn:
   * a line written to it would queue behind that task, and its stream now owes results no turn of
   * this plugin's is waiting for. The next prompt or close disposes it, unless it is serving a turn
   * (see `continuation`).
   */
  detached: AgyProcess | null;
  /** The transcript follow of the detached CLI, while it lives. */
  continuation: Continuation | null;
  /**
   * Turns announced while the detached CLI was carrying the conversation on. They are written to a
   * fresh CLI once that turn settles: killing the CLI mid-way would lose what it was doing.
   */
  deferred: PendingTurn[];
  /** The highest step a settled turn accounted for; a later step nobody prompted is a continuation. */
  settledStep: number;
  /** The plan a plan-mode turn ended with, while the user has not approved or dismissed it. */
  pendingPlan: { id: string; text: string } | null;
  /** Whether the host negotiated `permission`, without which a plan cannot be offered. */
  readonly planApproval: boolean;
}

/**
 * The launch-time flags that decide how a turn is served. All of them are fixed for the life of
 * the process, so a prompt that needs another profile gets a relaunched CLI instead.
 */
export interface LaunchProfile {
  /** Launched with `--json-schema`: the turn's answer is decoded JSON, not prose. */
  schema: boolean;
  /** Launched without `--disable-slash-commands`: `/name` expands, in a command turn only. */
  commands: boolean;
  /** The skill directory this process may read, for a plugin-expanded skill's turn, else null. */
  skillDir: string | null;
}

/**
 * agy runs queued stdin lines in order, so the *oldest* pending turn owns every incoming event:
 * a prompt sent while another turn is streaming must not relabel that turn's rows or clear the
 * text it has already accumulated.
 */
export interface PendingTurn {
  readonly turnId: string;
  /** Incremental assistant text per step_index, accumulated into complete snapshots. */
  readonly assistant: Map<number, string>;
  /** Tool rows published as `running` and not yet complete, keyed by call id. */
  readonly tools: Map<string, OpenToolCall>;
  /** The target file as it was when a snapshot tool started, keyed by call id. */
  readonly snapshots: Map<string, Promise<FileSnapshot | null>>;
  hadAssistantText: boolean;
  /**
   * Whether the CLI serving this turn was launched with `--json-schema`. Antigravity keeps a
   * schema with the *conversation* and reports the last `structured_output` again on later turns
   * of that conversation, even on a process started without the flag (probed 2026-09-23), so the
   * flag is what distinguishes this turn's answer from a stale one. The same flag decides that the
   * turn's text is buffered instead of streamed (see `handleStepUpdate`).
   */
  schema: boolean;
  /**
   * `input_tokens` of the last agent_response step that reported usage: the size the model's
   * context had reached, as opposed to the result's total across every step of the turn.
   */
  contextInputTokens?: number;
  /** Lowest step index the stream has delivered for this turn: where its part of the transcript starts. */
  firstStep: number;
  /** Highest step index the stream has delivered for this turn. */
  lastStreamStep: number;
  /**
   * Steps published from the conversation transcript while the stream was held, with the JSON
   * last published for each. The stream no longer owns these steps: when it catches up, its copy
   * of them is dropped rather than published a second time.
   */
  readonly backfilled: Map<number, string>;
  backfill: TranscriptTailer | null;
  backfillTimer: NodeJS.Timeout | null;
  /** Runs while an error is the last word of the transcript; fails the turn if it stays that way. */
  failureTimer: NodeJS.Timeout | null;
  /** The exact text written to agy, so a turn queued behind a detached CLI can be sent again. */
  outgoing: string;
  /** Sent in plan mode, so its answer is offered as a plan to implement. */
  plan: boolean;
  /** Whether the host has been told the turn started: a turn waiting for its CLI has not been. */
  announced: boolean;
  /** Whether `outgoing` carries the system prompt, which goes again if the turn never got an answer. */
  carriesSystemPrompt: boolean;
}

/**
 * Follows the conversation of a detached CLI. When a background task ends, agy tells the model in
 * a SYSTEM_MESSAGE and the model carries on in the same process — for dozens of steps, pushing code
 * and writing a new answer (seen in a real conversation: 64 steps after a long test run finished).
 * The detached stream is never read, so the transcript is the only place those steps appear.
 *
 * The turn that started the task is completed at its answer, like any other, and what the model
 * does afterwards is published as a turn the provider starts itself — an autonomous turn, with no
 * prompt behind it — from the first step where the model acts to its final answer.
 */
export interface Continuation {
  readonly tailer: TranscriptTailer;
  /** Every step up to here is already published under some turn. */
  settledStep: number;
  /** The autonomous turn publishing the steps past `settledStep`, while one is open. */
  turn: PendingTurn | null;
}

/** The fields of a tool row, kept so a call left open can be republished with a terminal status. */
export interface OpenToolCall {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly detail: ProviderToolCallDetail;
  readonly metadata: Record<string, JsonValue>;
}

type SubAgentDetail = Extract<ProviderToolCallDetail, { type: "sub_agent" }>;

/** What a subagent row knows about its child, published under `metadata.subagent`. */
export interface SubagentInfo {
  index: number;
  conversationId?: string;
  logUri?: string;
  typeName?: string;
  role?: string;
  prompt?: string;
  done?: boolean;
}

/**
 * One row of an `invoke_subagent` step, whether it was reported as a tool line carrying the
 * children's prompts or as a subagent line carrying the ids of the conversations they run in.
 *
 * The row is in `turn.tools` while its turn is pending — where it must always hold what is
 * currently true, because `finalizeToolCalls` republishes from there — and in `session.subagents`
 * afterwards, because the child outlives the turn and can still add its report to it.
 */
export interface SubagentRow {
  /** The row as last published; `detail` and `metadata` are rebuilt by `refreshSubagentRow`. */
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  detail: SubAgentDetail;
  metadata: Record<string, JsonValue>;
  /** The turn that published it, so a child can be attributed to the turn that spawned it. */
  readonly turnId: string | null;
  readonly stepIndex: number;
  info: SubagentInfo;
  /** The report the child sent, once it has one; the prompt until then. */
  log: string;
  actions?: SubagentAction[];
  /**
   * `running` until something settles the row: the child finishing, the turn ending in SUCCESS, or
   * the turn being canceled or failed. A row that is already terminal keeps that status, because
   * neither path may claim more than the other about a child that did or did not finish.
   */
  status: "running" | "completed" | "canceled" | "failed";
  error: JsonValue;
  /** Set once the child session was opened, which is also what links the row to it. */
  childSessionId: string | null;
  /**
   * The JSON this row was last published as, or null while it never was. A render publishes the
   * row only when this changes, so a child that reports nothing new costs neither a Paseo row nor
   * a write to the parent's transcript.
   */
  published: string | null;
}

/** One entry of a subagent row's action list, as the child's own transcript reports it. */
interface SubagentAction {
  index: number;
  toolName: string;
  summary?: string;
}

/** A child whose transcript this plugin is following, and the rows its steps become. */
export interface ChildFollow {
  /** The subagent row that names this child. */
  readonly rowId: string;
  readonly childConversationId: string;
  /** The child's session id in Paseo's namespace. */
  readonly childId: string;
  /** The turn that spawned it, or null for a child resumed from a replayed row. */
  readonly turnId: string | null;
  /** Assigned right after construction: the tailer's handlers need the follow they belong to. */
  transcript: SubagentTranscript;
  /** Null when the parent session is not persisted: the child's rows are then not stored either. */
  store: TranscriptStore | null;
  /** Whether the child's session events have been emitted; the session opens lazily. */
  opened: boolean;
  /** Whether the child reached its own last word. */
  done: boolean;
}

/** The error a failed turn reports, and whether retrying is likely to help. */
export interface TurnFailure {
  error: ProviderError;
  retryable: boolean;
}

export interface ConnectionState {
  capabilities: readonly ProviderCapability[];
  timing: Timing;
  sessions: Map<string, Session>;
}

export type Emit = (event: ProviderEvent) => void;

export interface TurnRequest {
  /** What the timeline shows the user sent. */
  shown: string;
  /** What the CLI is sent, before the system prompt and plan-mode preambles. */
  text: string;
  /** Absent for a turn the plugin starts itself, such as implementing an approved plan. */
  clientMessageId?: string;
  /** Written exactly as given: no system prompt and no plan-mode preamble in front of it. */
  verbatim: boolean;
}

export function createPendingTurn(session: Session, plan: boolean): PendingTurn {
  session.turnCounter += 1;
  return {
    turnId: `turn-${session.turnCounter}-${randomUUID().slice(0, 8)}`,
    assistant: new Map(),
    tools: new Map(),
    snapshots: new Map(),
    hadAssistantText: false,
    // Replaced with the launch profile of the process that actually serves the turn: a turn queued
    // behind another is answered by that process, not by the one its own prompt implies.
    schema: false,
    firstStep: -1,
    lastStreamStep: -1,
    backfilled: new Map(),
    backfill: null,
    backfillTimer: null,
    failureTimer: null,
    outgoing: "",
    plan,
    announced: false,
    carriesSystemPrompt: false,
  };
}

/** Tells the host the turn started, once. */
export function announceTurn(session: Session, emit: Emit, turn: PendingTurn): void {
  if (turn.announced) return;
  turn.announced = true;
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "started" });
}

/** How a turn whose result only the transcript has ended. */
export type Settlement =
  | { status: "completed"; finalStep: number; entries: readonly TranscriptEntry[] }
  | { status: "failed"; step: number; error: ProviderError };

/** How a turn settles the tool rows it left open. */
export type ToolTerminal =
  | { status: "canceled" }
  | { status: "completed" }
  | { status: "failed"; error: ProviderError };

/** One child as a subagent step reports it, whichever of the two lines carried it. */
export interface SubagentEntry {
  typeName?: string;
  role?: string;
  prompt?: string;
  conversationId?: string;
  logUri?: string;
}

/** How a turn ended without an answer. */
export type TurnOutcome = { state: "canceled" | "failed"; error: ProviderError };

export function requireSession(state: ConnectionState, sessionId: string): Session {
  const session = state.sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  return session;
}

export function itemId(turn: PendingTurn, stepIndex: number, kind: string): string {
  return `agy:${kind}:${turn.turnId}:${stepIndex}`;
}
