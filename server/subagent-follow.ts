/**
 * Subagents: the rows their steps become, and following each child's own transcript as its own
 * session.
 */

import type { ProviderError, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { CHILD_SESSION_MARKER, DESCRIPTION_LIMIT } from "./constants";
import type { AgyStepUpdate } from "./protocol";
import { publish } from "./publish";
import type { ChildFollow, Emit, PendingTurn, Session, SubagentEntry, SubagentRow } from "./state";
import { type ChildRender, SubagentTranscript } from "./subagents";
import { TranscriptStore } from "./transcript";
import { describe, runInBackground } from "./util";

/** The children a step names: the subagent line first, the tool call's parameters second. */
function readSubagentEntries(step: AgyStepUpdate): SubagentEntry[] {
  const reported = step.subagent_info?.subagents;
  if (reported && reported.length > 0) {
    return reported.map((child) => ({
      ...(child.type_name !== undefined ? { typeName: child.type_name } : {}),
      ...(child.role !== undefined ? { role: child.role } : {}),
      ...(child.initial_prompt !== undefined ? { prompt: child.initial_prompt } : {}),
      ...(child.conversation_id !== undefined ? { conversationId: child.conversation_id } : {}),
      ...(child.log_uri !== undefined ? { logUri: child.log_uri } : {}),
    }));
  }

  // The tool line carries the same children before they exist: what the model asked for, with the
  // prompt it wrote, which is all the row can show until the subagent line names their runs.
  const parameters = step.tool_info?.parameters;
  const requested = parameters?.Subagents;
  if (!Array.isArray(requested)) return [];
  const entries: SubagentEntry[] = [];
  for (const child of requested) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
    const record = child as Record<string, unknown>;
    entries.push({
      ...(typeof record.TypeName === "string" ? { typeName: record.TypeName } : {}),
      ...(typeof record.Role === "string" ? { role: record.Role } : {}),
      ...(typeof record.Prompt === "string" ? { prompt: record.Prompt } : {}),
    });
  }
  return entries;
}

/** The rows a step justifies: one per child, or a single nameless row when it names none. */
export function handleSubagentStep(
  session: Session,
  step: AgyStepUpdate,
  turn: PendingTurn,
  name: string,
  emit: Emit,
): void {
  const entries = readSubagentEntries(step);
  console.log(
    `[antigravity] subagent ${name} ${step.state} children=${entries.length} idx=${step.step_index}`,
  );

  const count = Math.max(entries.length, 1);
  for (let index = 0; index < count; index += 1) {
    const entry = entries[index] ?? {};
    // The step index and the child's position in it, not the call: agy reports one call spawning
    // several children, and each of them is its own row and its own session.
    const id = `agy:subagent:${turn.turnId}:${step.step_index}:${index}`;
    const row =
      session.subagents.get(id) ??
      createSubagentRow(name, id, turn.turnId, step.step_index, index);

    // The tool line's child and the subagent line's are the same child, so every field is set by
    // whichever line has it: the DONE line adds the conversation and its transcript's location to
    // the prompt and role the ACTIVE line already gave.
    if (entry.typeName !== undefined) row.info.typeName = entry.typeName;
    if (entry.role !== undefined) row.info.role = entry.role;
    if (entry.prompt !== undefined) row.info.prompt = entry.prompt;
    if (entry.conversationId !== undefined) row.info.conversationId = entry.conversationId;
    if (entry.logUri !== undefined) row.info.logUri = entry.logUri;
    if (entry.prompt !== undefined && row.log.length === 0) row.log = entry.prompt;

    refreshSubagentRow(row);
    session.subagents.set(id, row);
    turn.tools.set(id, row);
    publishSubagent(session, emit, row);

    if (row.status === "running" && entry.conversationId !== undefined && entry.logUri !== undefined) {
      void startChildFollow(session, emit, row, entry.conversationId, entry.logUri);
    }
  }
}

function createSubagentRow(
  name: string,
  id: string,
  turnId: string,
  stepIndex: number,
  index: number,
): SubagentRow {
  return {
    id,
    callId: id,
    name,
    detail: { type: "sub_agent", log: "" },
    metadata: {},
    turnId,
    stepIndex,
    info: { index },
    log: "",
    status: "running",
    error: null,
    childSessionId: null,
    published: null,
  };
}

/** The row's rendered fields, rebuilt from what the stream and the child have reported so far. */
export function refreshSubagentRow(row: SubagentRow): void {
  const type = row.info.role ?? row.info.typeName;
  row.detail = {
    type: "sub_agent",
    ...(row.info.typeName !== undefined ? { subAgentType: row.info.typeName } : {}),
    ...(type !== undefined ? { description: type } : {}),
    ...(row.childSessionId !== null ? { childSessionId: row.childSessionId } : {}),
    log: row.log,
    ...(row.actions !== undefined ? { actions: row.actions } : {}),
  };
  row.metadata = {
    stepIndex: row.stepIndex,
    subagent: {
      index: row.info.index,
      ...(row.info.conversationId !== undefined ? { conversationId: row.info.conversationId } : {}),
      ...(row.info.logUri !== undefined ? { logUri: row.info.logUri } : {}),
      ...(row.info.typeName !== undefined ? { typeName: row.info.typeName } : {}),
      ...(row.info.role !== undefined ? { role: row.info.role } : {}),
      ...(row.info.prompt !== undefined ? { prompt: row.info.prompt } : {}),
      ...(row.info.done === true ? { done: true } : {}),
    },
  };
}

/** The row Paseo is given for a subagent in the state it now holds. */
export function subagentItem(row: SubagentRow): ProviderTimelineItem {
  const base = {
    type: "tool_call" as const,
    id: row.id,
    callId: row.callId,
    name: row.name,
    detail: row.detail,
    metadata: row.metadata,
  };
  return row.status === "failed"
    ? { ...base, status: "failed", error: row.error }
    : { ...base, status: row.status, error: null };
}

/**
 * Republishes a subagent row if, and only if, what it renders has changed. A child reports on
 * every read of its transcript, and most reads say nothing new; publishing regardless would put
 * the same row through Paseo and through the parent's stored transcript on every one of them.
 */
export function publishSubagent(session: Session, emit: Emit, row: SubagentRow): void {
  const item = subagentItem(row);
  const json = JSON.stringify(item);
  if (json === row.published) return;
  row.published = json;
  publish(session, emit, item);
}

export function childSessionId(parentSessionId: string, childConversationId: string): string {
  return `${parentSessionId}${CHILD_SESSION_MARKER}${childConversationId}`;
}

/** The child's own turn: one turn per child conversation, named after it. */
export function childTurnId(childConversationId: string): string {
  return `agy-sub:${childConversationId}`;
}

/**
 * Closes a settled child's session, leaving it in the set of children this parent still has open.
 *
 * The host counts a child as live until it is closed, and on a lost connection it reports
 * `session.runtime_failed` for every live session — which is what turned finished children into
 * `failed` ones after a plugin reload. So a child closes as soon as its own turn is over, and with
 * the same error its turn ended with: the host reads a silent close as a child that completed.
 */
function closeChildSession(
  session: Session,
  emit: Emit,
  follow: ChildFollow,
  error?: ProviderError,
): void {
  // Several paths settle the same child — the child finishing, the turn ending, the transcript
  // being given up on — and only the first of them may close the session.
  if (!session.childSessions.delete(follow.childId)) return;
  emit({
    type: "session.closed",
    sessionId: follow.childId,
    ...(error !== undefined ? { error } : {}),
  });
}

/**
 * Starts following the transcript of one child. Everything here is best-effort: a transcript that
 * cannot be read, parsed, or watched costs the child's own session and nothing else — the row the
 * stream justified stays on screen, and the parent's turn is never failed or delayed by it. This
 * is the only caller of `followChildTranscript`, and the only place that has to be sure of that.
 */
async function startChildFollow(
  session: Session,
  emit: Emit,
  row: SubagentRow,
  childConversationId: string,
  logUri: string,
): Promise<void> {
  try {
    await followChildTranscript(session, emit, row, childConversationId, logUri);
  } catch (error) {
    // Nothing a child does may fail or delay the parent's turn, so anything that goes wrong here
    // ends with the child's transcript unfollowed and a line in the log.
    console.error(
      `[antigravity] could not follow subagent ${childConversationId}: ${describe(error)}`,
    );
  }
}

async function followChildTranscript(
  session: Session,
  emit: Emit,
  row: SubagentRow,
  childConversationId: string,
  logUri: string,
): Promise<void> {
  if (session.follows.has(row.id) || session.closing) return;

  // The child's rows are stored under the child's own conversation, so a reload can replay them
  // with the child. Loading first means a resumed child keeps the rows its earlier run produced.
  let store: TranscriptStore | null = null;
  if (session.persist) {
    try {
      store = await TranscriptStore.load(childConversationId);
    } catch (error) {
      console.error(
        `[antigravity] could not read the transcript of ${childConversationId}: ${describe(error)}`,
      );
    }
  }
  // The await above is long enough for the session to have closed under us.
  if (session.closing || session.follows.has(row.id)) return;

  const follow: ChildFollow = {
    rowId: row.id,
    childConversationId,
    childId: childSessionId(session.sessionId, childConversationId),
    turnId: row.turnId,
    store,
    opened: false,
    done: false,
    transcript: null as unknown as SubagentTranscript,
  };
  follow.transcript = new SubagentTranscript(
    {
      logUri,
      childConversationId,
      parentConversationId: session.conversationId ?? "",
      cwd: session.config.cwd,
    },
    {
      onRender: (render, changed) => handleChildRender(session, emit, follow, render, changed),
      // A transcript that cannot be followed at all leaves the row exactly as A published it,
      // which is why this degrades to that rather than removing or failing anything.
      onDegrade: (reason) =>
        console.error(`[antigravity] not following subagent ${childConversationId}: ${reason}`),
      onLost: (reason) => handleChildLost(session, emit, follow, reason),
    },
  );
  session.follows.set(row.id, follow);
  follow.transcript.start();
}

/** Publishes what a child has done since the last read, and settles it when it is finished. */
export function handleChildRender(
  session: Session,
  emit: Emit,
  follow: ChildFollow,
  render: ChildRender,
  changed: readonly ProviderTimelineItem[],
): void {
  if (session.closing) return;
  // The session opens on the first read that has something in it: a transcript that is missing or
  // is still empty must not put a child on screen that never says anything.
  if (!follow.opened) {
    if (render.items.length === 0) return;
    follow.opened = true;
    session.childSessions.add(follow.childId);
    const row = session.subagents.get(follow.rowId);
    const title = row?.info.role ?? row?.info.typeName ?? "Subagent";
    emit({
      type: "session.opened",
      sessionId: follow.childId,
      parentSessionId: session.sessionId,
      toolCallId: follow.rowId,
      capabilities: [],
      restoration: "parent",
      title,
      description: (row?.info.prompt ?? "").slice(0, DESCRIPTION_LIMIT),
      cwd: session.config.cwd,
    });
    emit({ type: "session.ready", sessionId: follow.childId });
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: "started",
    });
  }

  for (const item of changed) {
    if (follow.store) follow.store.upsert(item);
    emit({ type: "timeline.item", sessionId: follow.childId, item });
  }

  follow.done = render.done;
  const row = session.subagents.get(follow.rowId);
  if (row) {
    row.childSessionId = follow.childId;
    if (render.report.length > 0) row.log = render.report;
    if (render.actions.length > 0) row.actions = [...render.actions];
    if (render.done) row.info.done = true;
    // The child finished, and the row does not need the turn to say so; a row something else has
    // already settled keeps that status, since a later report cannot unsay what happened.
    if (render.done && row.status === "running") row.status = "completed";
    refreshSubagentRow(row);
    publishSubagent(session, emit, row);
  }

  if (render.done) {
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: "completed",
    });
    closeChildSession(session, emit, follow);
    follow.transcript.stop();
    // A finished child is not followed again, and nothing is left to settle for it later.
    session.follows.delete(follow.rowId);
    // The child's rows are complete here, so they no longer have to wait out the write debounce:
    // a session closed right after this still replays everything the child said.
    runInBackground("write a subagent's timeline", Promise.resolve(follow.store?.flush()));
  }
}

/** The child stopped writing before finishing: its own turn is canceled, never completed. */
export function handleChildLost(session: Session, emit: Emit, follow: ChildFollow, reason: string): void {
  console.error(`[antigravity] stopped following subagent ${follow.childConversationId}`);
  if (session.closing || !follow.opened || follow.done) return;
  const error: ProviderError = { message: reason };
  emit({
    type: "session.turn",
    sessionId: follow.childId,
    turnId: childTurnId(follow.childConversationId),
    state: "canceled",
    error,
  });
  // What the child did say is its history whatever ended it, so it is written out now rather than
  // left to a debounce that may never fire.
  runInBackground("write a subagent's timeline", Promise.resolve(follow.store?.flush()));
  closeChildSession(session, emit, follow, error);
}

/**
 * The parent's turn is over, so the children it spawned are no longer going to be reported on it.
 * Each transcript gets one last read — the child may well have finished while the parent was
 * writing its answer — and then is left alone; a child that had not finished is canceled or failed
 * along with the turn that spawned it.
 */
export async function settleChildFollows(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  outcome: { state: "canceled"; error: ProviderError } | { state: "failed"; error: ProviderError },
): Promise<void> {
  for (const follow of [...session.follows.values()]) {
    if (follow.turnId !== turn.turnId) continue;
    session.follows.delete(follow.rowId);
    try {
      await follow.transcript.readFinal();
    } catch (error) {
      console.error(
        `[antigravity] could not read the last of subagent ${follow.childConversationId}: ${describe(error)}`,
      );
    }
    follow.transcript.stop();
    // The child said everything it is going to say, so its rows are written out now rather than
    // left to a debounce this session may not live long enough to see.
    runInBackground("write a subagent's timeline", Promise.resolve(follow.store?.flush()));
    if (session.closing || follow.done || !follow.opened) continue;
    emit({
      type: "session.turn",
      sessionId: follow.childId,
      turnId: childTurnId(follow.childConversationId),
      state: outcome.state,
      error: outcome.error,
    });
    closeChildSession(session, emit, follow, outcome.error);
  }
}
