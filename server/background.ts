/**
 * What happens to a conversation while a background task holds agy's stream: following the
 * transcript, settling the turn from it, and carrying on as a turn of its own.
 */

import type { ProviderError } from "@getpaseo/plugin/server/provider";
import { AgyProcess } from "./agy";
import { conversationTranscriptPath, modelActed, renderBackfill, stepsPast } from "./backfill";
import { lastAssistantText, offerPlan } from "./plan";
import { emitNotice, publish } from "./publish";
import {
  announceTurn,
  type Continuation,
  createPendingTurn,
  type Emit,
  itemId,
  type PendingTurn,
  type Session,
  type Settlement,
} from "./state";
import { settleChildFollows } from "./subagent-follow";
import type { TranscriptEntry } from "./subagents";
import { TranscriptReader, TranscriptTailer } from "./tail";
import { openBackgroundTasks } from "./tasks";
import { finalizeToolCalls } from "./turn-end";
import { writePendingTurn } from "./turns";
import { runInBackground } from "./util";

/**
 * Disposes the CLI left holding a background task, so a fresh one serves the next turn. One that is
 * carrying the conversation on is left alone: the turn that would replace it waits instead.
 *
 * An idle detached CLI is replaced rather than given the turn. Its stream still owes the `result`
 * of the turn that was settled from the transcript, plus whatever it reports for the steps it took
 * on its own — how many results that is was never observed — and every result is matched to the
 * oldest pending turn, so a turn written to it could be settled by an answer that is not its own.
 */
export async function releaseDetached(session: Session): Promise<void> {
  if (!session.detached) return;
  // One last read first: the model may have been woken since the poll last looked, and what it did
  // is lost for good once its CLI is gone. If it is in the middle of something, it is left alone.
  await session.continuation?.tailer.drain();
  const detached = session.detached;
  if (!detached || isContinuing(session)) return;
  stopContinuation(session);
  session.detached = null;
  console.log("[antigravity] stopping the detached CLI so a fresh one serves the next turn");
  await detached.dispose();
}

/**
 * Starts reading the conversation transcript once a tool has been ACTIVE for a while, because a
 * command agy moved to the background holds the rest of the stream back (see `backfill.ts`).
 */
export function scheduleBackfill(session: Session, turn: PendingTurn, emit: Emit): void {
  if (turn.backfill || turn.backfillTimer) return;
  const delay = session.timing.backfillDelayMs;
  turn.backfillTimer = setTimeout(() => {
    turn.backfillTimer = null;
    const conversationId = session.conversationId;
    // The tool reported back in time, or the turn is already over: nothing is held.
    if (session.closing || session.pendingTurns[0] !== turn || turn.tools.size === 0) return;
    if (conversationId === null) return;
    console.log(
      `[antigravity] a tool has been running for ${delay / 1000}s; following the conversation transcript`,
    );
    // Only this turn's steps are needed, and the file holds every turn of the conversation.
    const reader = new TranscriptReader(conversationTranscriptPath(conversationId), {
      fromStep: Math.max(turn.firstStep, 0),
    });
    turn.backfill = new TranscriptTailer(
      reader,
      {
        onChange: (entries) => applyBackfill(session, turn, entries, emit),
        onError: (reason) => failTurnFromTranscript(session, turn, emit, reason),
      },
      session.timing.transcriptPollMs,
    );
    turn.backfill.start();
  }, delay);
  turn.backfillTimer.unref();
}

export function stopBackfill(turn: PendingTurn): void {
  if (turn.backfillTimer) clearTimeout(turn.backfillTimer);
  turn.backfillTimer = null;
  if (turn.failureTimer) clearTimeout(turn.failureTimer);
  turn.failureTimer = null;
  turn.backfill?.stop();
  turn.backfill = null;
}

/**
 * Publishes the steps the transcript holds and the stream has not delivered, and settles the turn
 * once the transcript shows its final answer, or once an error has been its last word for
 * `failureQuietMs`. A step the stream already delivered stays the stream's; a step published here
 * stays this function's, whatever the stream sends later.
 */
function applyBackfill(
  session: Session,
  turn: PendingTurn,
  entries: readonly TranscriptEntry[],
  emit: Emit,
): void {
  if (session.closing || session.pendingTurns[0] !== turn) {
    stopBackfill(turn);
    return;
  }
  const render = renderBackfill(
    entries,
    {
      message: (stepIndex) => itemId(turn, stepIndex, "msg"),
      tool: (stepIndex) => itemId(turn, stepIndex, "tool"),
    },
    session.config.cwd,
  );
  publishTranscriptRows(session, emit, turn, render.rows);
  if (turn.failureTimer) clearTimeout(turn.failureTimer);
  turn.failureTimer = null;
  if (render.finalStep !== null && turn.backfilled.has(render.finalStep)) {
    settleFromTranscript(session, turn, emit, {
      status: "completed",
      finalStep: render.finalStep,
      entries,
    });
    return;
  }
  // agy retries a failed model call, so an error is only the end once nothing has followed it.
  const failure = render.failure;
  if (failure === null) return;
  turn.failureTimer = setTimeout(() => {
    turn.failureTimer = null;
    if (session.closing || session.pendingTurns[0] !== turn) return;
    settleFromTranscript(session, turn, emit, {
      status: "failed",
      step: failure.step,
      error: { message: failure.message, code: "agy_error" },
    });
  }, session.timing.failureQuietMs);
  turn.failureTimer.unref();
}

/** The transcript of a stream-held turn cannot be read, so its answer will never be seen. */
function failTurnFromTranscript(session: Session, turn: PendingTurn, emit: Emit, reason: string): void {
  if (session.closing || session.pendingTurns[0] !== turn) return;
  console.error(`[antigravity] ${reason}`);
  settleFromTranscript(session, turn, emit, {
    status: "failed",
    step: session.settledStep,
    error: {
      message: `Antigravity's conversation transcript could not be followed: ${reason}`,
      code: "transcript_unreadable",
    },
  });
}

/** Publishes the transcript's rows a turn does not have yet, and tracks them as that turn's. */
function publishTranscriptRows(
  session: Session,
  emit: Emit,
  turn: PendingTurn,
  rows: ReturnType<typeof renderBackfill>["rows"],
): void {
  for (const { stepIndex, item } of rows) {
    if (stepIndex <= turn.lastStreamStep && !turn.backfilled.has(stepIndex)) continue;
    const json = JSON.stringify(item);
    if (turn.backfilled.get(stepIndex) === json) continue;
    turn.backfilled.set(stepIndex, json);
    if (item.type === "tool_call") {
      if (item.status === "running") {
        turn.tools.set(item.callId, {
          id: item.id,
          callId: item.callId,
          name: item.name,
          detail: item.detail,
          metadata: { ...item.metadata },
        });
      } else {
        turn.tools.delete(item.callId);
      }
    } else if (item.type === "assistant_message") {
      turn.assistant.set(stepIndex, item.text);
      turn.hadAssistantText = true;
    }
    publish(session, emit, item);
  }
}

/**
 * Ends a turn whose outcome only the transcript has. The CLI serving it still owes that turn's
 * `result`, and will not read another line until its background task ends, so it is detached:
 * nothing it prints is used any more, and a fresh CLI resumes the conversation for the next turn.
 *
 * A completed answer is final for this turn, as any answer is. If a task the turn started ends
 * later and agy wakes the model, what it does then is published as a turn of its own (see
 * `Continuation`). A failed turn has no such afterlife: agy exits after an error, so its CLI is
 * released.
 */
function settleFromTranscript(session: Session, turn: PendingTurn, emit: Emit, settlement: Settlement): void {
  stopBackfill(turn);
  const step = settlement.status === "completed" ? settlement.finalStep : settlement.step;
  session.settledStep = Math.max(session.settledStep, step);
  const queued = session.pendingTurns.filter((pending) => pending !== turn);
  session.pendingTurns = [];
  console.log(`[antigravity] settled ${turn.turnId} (${settlement.status}) from the conversation transcript`);

  const stuck = session.process;
  session.process = null;
  if (settlement.status === "failed") {
    finalizeToolCalls(session, emit, turn, { status: "failed", error: settlement.error });
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: "failed",
      error: settlement.error,
    });
    runInBackground("settle the subagents", settleChildFollows(session, emit, turn, { state: "failed", error: settlement.error }));
    if (stuck) runInBackground("stop the CLI", stuck.dispose());
  } else {
    finalizeToolCalls(session, emit, turn, { status: "completed" });
    emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
    offerPlan(session, emit, turn, lastAssistantText(turn));
    if (stuck) detachProcess(session, emit, stuck);
    if (openBackgroundTasks(settlement.entries, settlement.finalStep).size > 0) {
      emitBackgroundTaskNotice(session, emit);
    }
  }
  // Turns written behind the settled one were queued inside the detached CLI and would never run
  // there, so they go to the fresh one instead. Their `started` was already announced.
  if (queued.length > 0) runInBackground("send the queued turns", resendQueued(session, emit, queued));
}

/** Tells the user that a turn completed while a command it started still runs in the background. */
function emitBackgroundTaskNotice(session: Session, emit: Emit): void {
  emitNotice(
    session,
    emit,
    "agy-background-task",
    "info",
    "A background command is still running",
    "Antigravity left a command running in the background (for example a dev server) after its answer. If it finishes first, Antigravity may carry on with the conversation, and what it does is shown here as its own turn. Otherwise it keeps running until your next message, which resumes this conversation in a fresh Antigravity CLI and stops it.",
  );
}

async function resendQueued(session: Session, emit: Emit, queued: readonly PendingTurn[]): Promise<void> {
  await releaseDetached(session);
  for (const turn of queued) await writePendingTurn(session, emit, turn);
}

/** Whether the detached CLI is serving a turn: the model carrying the conversation on by itself. */
export function isContinuing(session: Session): boolean {
  return session.continuation?.turn != null;
}

/**
 * Takes a CLI off the session — its stream is no longer read — and follows the conversation it
 * holds from the transcript for as long as it lives.
 */
function detachProcess(session: Session, emit: Emit, process: AgyProcess): void {
  stopContinuation(session);
  if (session.detached) runInBackground("stop the previous CLI", session.detached.dispose());
  session.detached = process;
  const conversationId = session.conversationId;
  if (conversationId === null || session.closing) return;
  // What the model does from here on is all that is read: everything up to the settled step is
  // already published.
  const reader = new TranscriptReader(conversationTranscriptPath(conversationId), {
    fromStep: session.settledStep + 1,
  });
  const continuation: Continuation = {
    tailer: new TranscriptTailer(
      reader,
      {
        onChange: (entries) => applyContinuation(session, emit, continuation, entries),
        onError: (reason) => handleContinuationError(session, emit, continuation, reason),
      },
      session.timing.transcriptPollMs,
    ),
    settledStep: session.settledStep,
    turn: null,
  };
  session.continuation = continuation;
  continuation.tailer.start();
}

/** Stops following the detached CLI's conversation. An open continuation is settled by the caller. */
export function stopContinuation(session: Session): void {
  session.continuation?.tailer.stop();
  session.continuation = null;
}

/**
 * The transcript of the detached CLI cannot be read, so nothing more of what the model does can be
 * shown. A turn already open is failed, because its answer will never be seen; otherwise the
 * conversation simply stops being followed until the next prompt.
 */
function handleContinuationError(
  session: Session,
  emit: Emit,
  continuation: Continuation,
  reason: string,
): void {
  if (session.closing || session.continuation !== continuation) return;
  console.error(`[antigravity] ${reason}`);
  const turn = continuation.turn;
  continuation.turn = null;
  if (turn === null) return;
  const error: ProviderError = {
    message: `Antigravity's conversation transcript could not be followed: ${reason}`,
    code: "transcript_unreadable",
  };
  finalizeToolCalls(session, emit, turn, { status: "failed", error });
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "failed", error });
  if (session.deferred.length > 0) runInBackground("send the deferred turns", sendDeferred(session, emit));
}

/**
 * Publishes the steps the detached CLI took since the last settled one, as a turn of the plugin's
 * own. The turn opens at the first step where the model acts — the SYSTEM_MESSAGE announcing a
 * finished task comes first, and one that does not wake the model (a canceled task, say) opens
 * nothing — and the model's final answer completes it. Another wake-up after that opens the next.
 */
function applyContinuation(
  session: Session,
  emit: Emit,
  continuation: Continuation,
  entries: readonly TranscriptEntry[],
): void {
  if (session.closing || session.continuation !== continuation) return;
  // A prompted turn is being served by a CLI of its own: it owns the timeline until it settles.
  if (session.pendingTurns.length > 0) return;

  const past = stepsPast(entries, continuation.settledStep);
  let turn = continuation.turn;
  if (turn === null) {
    if (!modelActed(past)) return;
    turn = createPendingTurn(session, false);
    continuation.turn = turn;
    console.log(
      `[antigravity] the conversation carried on after step ${continuation.settledStep}; publishing it as ${turn.turnId}`,
    );
    announceTurn(session, emit, turn);
  }
  const render = renderBackfill(
    past,
    {
      message: (stepIndex) => itemId(turn, stepIndex, "msg"),
      tool: (stepIndex) => itemId(turn, stepIndex, "tool"),
    },
    session.config.cwd,
  );
  publishTranscriptRows(session, emit, turn, render.rows);
  const finalStep = render.finalStep;
  if (finalStep === null || !turn.backfilled.has(finalStep)) return;

  // As provisional as any answer settled from the transcript: another task may end and wake the
  // model again, which opens the next continuation from here.
  continuation.turn = null;
  continuation.settledStep = finalStep;
  session.settledStep = Math.max(session.settledStep, finalStep);
  finalizeToolCalls(session, emit, turn, { status: "completed" });
  emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
  if (session.deferred.length > 0) runInBackground("send the deferred turns", sendDeferred(session, emit));
}

/** Writes the turns deferred behind a continuation to a fresh CLI, in the order they were sent. */
async function sendDeferred(session: Session, emit: Emit): Promise<void> {
  await releaseDetached(session);
  // A prompt that arrives while this runs joins the queue, so it cannot overtake the ones before it.
  while (session.deferred.length > 0 && !session.closing) {
    const turn = session.deferred.shift();
    if (turn) await writePendingTurn(session, emit, turn);
  }
}

/**
 * The detached CLI is gone. A continuation it was in the middle of ends with it; the turns deferred
 * behind it are sent to a fresh CLI, unless the exit was the user stopping the continuation, which
 * stops what was queued behind it too, as it does for turns queued inside a running CLI.
 */
export function handleDetachedExit(session: Session, emit: Emit): void {
  session.detached = null;
  const turn = session.continuation?.turn ?? null;
  stopContinuation(session);
  if (session.closing) return;
  const canceled = session.interrupting;
  const error: ProviderError = canceled
    ? { message: "Interrupted", code: "interrupted" }
    : { message: "Antigravity exited while it was carrying on with the conversation", code: "agy_exit" };
  if (turn) {
    finalizeToolCalls(session, emit, turn, canceled ? { status: "canceled" } : { status: "failed", error });
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: canceled ? "canceled" : "failed",
      error,
    });
    // A held turn's children were spawned by the CLI that is gone, as for a turn it was streaming.
    runInBackground("settle the subagents", settleChildFollows(session, emit, turn, { state: canceled ? "canceled" : "failed", error }));
  }
  if (!canceled) {
    if (session.deferred.length > 0) runInBackground("send the deferred turns", sendDeferred(session, emit));
    return;
  }
  const deferred = session.deferred;
  session.deferred = [];
  for (const pending of deferred) {
    emit({ type: "session.turn", sessionId: session.sessionId, turnId: pending.turnId, state: "canceled", error });
  }
}
