/**
 * Republishing the rows a session stored, and the child sessions its subagent rows spawned.
 */

import { existsSync } from "node:fs";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { DESCRIPTION_LIMIT } from "./constants";
import type { JsonValue } from "./json";
import type { ChildFollow, Emit, Session, SubagentInfo, SubagentRow } from "./state";
import {
  childSessionId,
  childTurnId,
  handleChildLost,
  handleChildRender,
  refreshSubagentRow,
  subagentItem,
} from "./subagent-follow";
import { SubagentTranscript, transcriptFilePath } from "./subagents";
import { TranscriptStore } from "./transcript";
import { describe } from "./util";

/**
 * A tool call stored as running belongs to a turn that was cut short — the plugin went away, or
 * was stopped, before anything settled it — and no process is left to finish it. Replayed as it was
 * stored it would spin forever, so it is shown as what became of it: canceled.
 */
function settleStaleToolCall(item: ProviderTimelineItem): ProviderTimelineItem {
  if (item.type !== "tool_call" || item.status !== "running") return item;
  return { ...item, status: "canceled", error: null };
}

/** What a stored row knows about the child it spawned, as `refreshSubagentRow` wrote it. */
function readSubagentInfo(item: ProviderTimelineItem): SubagentInfo | null {
  if (item.type !== "tool_call") return null;
  const subagent = item.metadata?.subagent;
  if (typeof subagent !== "object" || subagent === null || Array.isArray(subagent)) return null;
  const record = subagent as Record<string, JsonValue>;
  return {
    index: typeof record.index === "number" ? record.index : 0,
    ...(typeof record.conversationId === "string" ? { conversationId: record.conversationId } : {}),
    ...(typeof record.logUri === "string" ? { logUri: record.logUri } : {}),
    ...(typeof record.typeName === "string" ? { typeName: record.typeName } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
    ...(record.done === true ? { done: true } : {}),
  };
}

/**
 * Republishes one stored row, and with it the child session the row spawned.
 *
 * A stored subagent row names the conversation its child ran in, and the child's own rows were
 * stored under that conversation. They are replayed under the id *this* parent session gives the
 * child, and the id is derived from the parent's — which changes with every session — so the row
 * client draws and the child it links to always agree.
 */
export async function replayItem(
  session: Session,
  emit: Emit,
  item: ProviderTimelineItem,
): Promise<void> {
  const info = readSubagentInfo(item);
  if (item.type !== "tool_call" || info === null || info.conversationId === undefined) {
    emit({ type: "timeline.item", sessionId: session.sessionId, item: settleStaleToolCall(item) });
    return;
  }
  try {
    await replaySubagentItem(session, emit, item, { ...info, conversationId: info.conversationId });
  } catch (error) {
    // Replaying a child is best-effort like everything else of B: failing `session.open` over it
    // would be worse than opening without the child.
    console.error(
      `[antigravity] could not replay the subagent ${info.conversationId}: ${describe(error)}`,
    );
  }
}

async function replaySubagentItem(
  session: Session,
  emit: Emit,
  item: Extract<ProviderTimelineItem, { type: "tool_call" }>,
  info: SubagentInfo & { conversationId: string },
): Promise<void> {
  // The child's rows were stored under the child's own conversation, which is what the row's
  // metadata names; a subagent row whose child kept nothing is replayed without a link, since the
  // id the stored link holds belongs to a parent session that no longer exists.
  const stored = await TranscriptStore.load(info.conversationId);
  const childItems = stored.list();
  const childId = childSessionId(session.sessionId, info.conversationId);
  const detail = item.detail.type === "sub_agent" ? item.detail : null;
  const row: SubagentRow = {
    id: item.id,
    callId: item.callId,
    name: item.name,
    detail: detail ?? { type: "sub_agent", log: "" },
    metadata: {},
    turnId: null,
    stepIndex: typeof item.metadata?.stepIndex === "number" ? item.metadata.stepIndex : 0,
    info,
    log: detail?.log ?? info.prompt ?? "",
    ...(detail?.actions !== undefined ? { actions: [...detail.actions] } : {}),
    status: item.status,
    error: item.status === "failed" ? item.error : null,
    childSessionId: childItems.length > 0 ? childId : null,
    published: null,
  };
  refreshSubagentRow(row);
  // Published with `emit`, not `publish`: replaying a row must not write it again, which would
  // move it to the end of the store and reorder the rows of the next replay.
  const rendered = subagentItem(row);
  row.published = JSON.stringify(rendered);
  emit({ type: "timeline.item", sessionId: session.sessionId, item: rendered });
  if (childItems.length === 0) return;

  emit({
    type: "session.opened",
    sessionId: childId,
    parentSessionId: session.sessionId,
    toolCallId: row.id,
    capabilities: [],
    restoration: "parent",
    title: row.info.role ?? row.info.typeName ?? "Subagent",
    description: (row.info.prompt ?? "").slice(0, DESCRIPTION_LIMIT),
    cwd: session.config.cwd,
  });
  emit({ type: "session.ready", sessionId: childId });
  emit({
    type: "session.turn",
    sessionId: childId,
    turnId: childTurnId(info.conversationId),
    state: "started",
  });
  for (const child of childItems) emit({ type: "timeline.item", sessionId: childId, item: child });
  if (info.done === true) {
    // The child had already finished when it was stored, so its session is closed with its turn:
    // a child the host still counts as live is one it reports as failed on the next reload.
    emit({
      type: "session.turn",
      sessionId: childId,
      turnId: childTurnId(info.conversationId),
      state: "completed",
    });
    emit({ type: "session.closed", sessionId: childId });
    return;
  }

  // The child never finished. Its transcript is still being written if it is still there, and the
  // rows it holds are the ones this replay just published, so a later read only adds to them.
  const path = info.logUri === undefined ? null : transcriptFilePath(info.logUri);
  if (path === null || !existsSync(path)) {
    // Nothing left to follow, and a child cannot stay open forever: it ends where its stored rows
    // do, with the reason it can go no further.
    emit({
      type: "session.closed",
      sessionId: childId,
      error: { message: "The subagent's transcript is no longer available" },
    });
    return;
  }
  if (session.closing) return;
  // Followed from here on, so the parent's own close still covers it if it never finishes.
  session.childSessions.add(childId);
  session.subagents.set(row.id, row);
  const follow: ChildFollow = {
    rowId: row.id,
    childConversationId: info.conversationId,
    childId,
    turnId: null,
    store: stored,
    opened: true,
    done: false,
    transcript: null as unknown as SubagentTranscript,
  };
  follow.transcript = new SubagentTranscript(
    {
      logUri: info.logUri ?? "",
      childConversationId: info.conversationId,
      parentConversationId: session.conversationId ?? "",
      cwd: session.config.cwd,
    },
    {
      onRender: (render, changed) => handleChildRender(session, emit, follow, render, changed),
      onDegrade: (reason) =>
        console.error(`[antigravity] not following subagent ${info.conversationId}: ${reason}`),
      onLost: (reason) => handleChildLost(session, emit, follow, reason),
    },
  );
  session.follows.set(row.id, follow);
  follow.transcript.start();
}
