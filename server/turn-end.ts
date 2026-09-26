/**
 * Ending a turn without an answer, and settling what it left open.
 */

import type { ProviderError } from "@getpaseo/plugin/server/provider";
import { stopBackfill } from "./background";
import { UNAVAILABLE_PATTERN } from "./constants";
import { emitNotice, publish, publishBufferedAnswer } from "./publish";
import {
  announceTurn,
  type Emit,
  type PendingTurn,
  type Session,
  type ToolTerminal,
  type TurnFailure,
  type TurnOutcome,
} from "./state";
import { publishSubagent, settleChildFollows } from "./subagent-follow";
import { releaseSystemPrompt } from "./turns";
import { runInBackground, toErrorJson } from "./util";

/**
 * Ends a turn that did not complete: whatever the model said is published, the tool rows it left
 * open are settled to match, the host is told, and the subagents it spawned are settled with it.
 */
export function endTurn(session: Session, emit: Emit, turn: PendingTurn, outcome: TurnOutcome): void {
  stopBackfill(turn);
  publishBufferedAnswer(session, emit, turn);
  releaseSystemPrompt(session, turn);
  finalizeToolCalls(
    session,
    emit,
    turn,
    outcome.state === "canceled" ? { status: "canceled" } : { status: "failed", error: outcome.error },
  );
  announceTurn(session, emit, turn);
  emit({
    type: "session.turn",
    sessionId: session.sessionId,
    turnId: turn.turnId,
    state: outcome.state,
    error: outcome.error,
  });
  // The process that was serving the turn is gone or going, so the children it spawned can no
  // longer be followed. Their transcripts get one last read first: a child that finished while the
  // process died is still finished.
  runInBackground("settle the subagents", settleChildFollows(session, emit, turn, outcome));
}

/** The turn now at the front of the queue starts, now that the one before it is over. */
export function startNextPending(session: Session, emit: Emit): void {
  const next = session.pendingTurns[0];
  if (next) announceTurn(session, emit, next);
}

/**
 * The error a failed turn reports. A structured `AGY_ERROR` line is canonical when the process
 * printed one; otherwise a transient outage is named `unavailable` so a retry is obvious, and any
 * other failure keeps the status agy reported or the exit-path code.
 */
export function turnFailure(session: Session, fallback: { message: string; code: string }): TurnFailure {
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

export function emitUnavailableNotice(session: Session, emit: Emit): void {
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
 *
 * A subagent row is republished from `session.subagents`, which holds the newest detail and
 * metadata — the child may have reported while the turn was still running — and keeps a status
 * something else has already settled: a child that finished did finish, whatever the turn then did.
 */
export function finalizeToolCalls(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  terminal: ToolTerminal,
): void {
  if (turn.tools.size === 0) return;
  for (const tool of turn.tools.values()) {
    const subagent = session.subagents.get(tool.id);
    if (subagent) {
      if (subagent.status === "running") {
        if (terminal.status === "failed") {
          subagent.status = "failed";
          subagent.error = toErrorJson(terminal.error);
        } else {
          subagent.status = terminal.status;
        }
      }
      publishSubagent(session, emit, subagent);
      continue;
    }
    const base = { type: "tool_call" as const, ...tool };
    if (terminal.status === "failed") {
      publish(session, emit, { ...base, status: "failed", error: toErrorJson(terminal.error) });
    } else if (terminal.status === "canceled") {
      publish(session, emit, { ...base, status: "canceled", error: null });
    } else {
      publish(session, emit, { ...base, status: "completed", error: null });
    }
  }
  turn.tools.clear();
}
