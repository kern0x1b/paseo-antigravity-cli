/**
 * Putting rows, notices and prompt results on the wire (and into the session's stored timeline).
 */

import type { ProviderError, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { Emit, PendingTurn, Session } from "./state";

export function publish(session: Session, emit: Emit, item: ProviderTimelineItem): void {
  if (session.transcript) session.transcript.upsert(item);
  else if (session.persist) session.unpersisted.push(item);
  emit({ type: "timeline.item", sessionId: session.sessionId, item });
}

/**
 * Publishes the text a schema turn buffered while streaming none. A plain turn's text is already
 * on screen, and republishing it would append a second copy under Paseo's delta mapping. `fallback`
 * is the result's own text, used when the process produced no text at all.
 */
export function publishBufferedAnswer(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  fallback = "",
): void {
  if (!turn.schema) return;
  const buffered = [...turn.assistant.values()].join("");
  const text = buffered.trim().length > 0 ? buffered : fallback;
  if (text.trim().length === 0) return;
  publish(session, emit, {
    type: "assistant_message",
    id: `agy:result:${turn.turnId}`,
    text,
  });
}

/** A prompt that never became a turn: nothing was written to agy and no turn id exists yet. */
export function failPrompt(
  session: Session,
  emit: Emit,
  clientMessageId: string,
  error: ProviderError,
): void {
  emit({
    type: "session.prompt_result",
    sessionId: session.sessionId,
    clientMessageId,
    result: { type: "failed", error },
  });
}

export function emitNotice(
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
