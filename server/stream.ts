/**
 * Reading agy's stream: turning its events into rows, and its result into the end of a turn.
 */

import type { ProviderUsage } from "@getpaseo/plugin/server/provider";
import { scheduleBackfill, stopBackfill } from "./background";
import { INVOKE_SUBAGENT } from "./constants";
import { isObservedTool, isSnapshotTool, readSnapshot, snapshotTarget } from "./edits";
import { publishEditDiff, rememberObserved } from "./file-diff";
import { persistenceFor } from "./persistence";
import { lastAssistantText, offerPlan } from "./plan";
import { failEverythingPending, retireProcess } from "./process";
import {
  type AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
  type AgyUsage,
  isInterrupted,
  STEP_AGENT_RESPONSE,
  STEP_STATE_DONE,
  STEP_SUBAGENT,
  STEP_TOOL,
} from "./protocol";
import { publish, publishBufferedAnswer } from "./publish";
import { type Emit, itemId, type OpenToolCall, type Session } from "./state";
import { handleSubagentStep } from "./subagent-follow";
import { hasEditContent, mapToolDetail } from "./tools";
import { TranscriptStore } from "./transcript";
import {
  emitUnavailableNotice,
  endTurn,
  finalizeToolCalls,
  startNextPending,
  turnFailure,
} from "./turn-end";
import { toJson } from "./util";

export function handleAgyEvent(session: Session, event: AgyEvent, emit: Emit): void {
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
    case "malformed": {
      console.error(`[antigravity] dropping a ${event.event} line it cannot decode: ${event.reason}`);
      // A result ends a turn, and the CLI stays up waiting for the next line whatever it printed,
      // so a turn whose result is unreadable would otherwise run forever.
      const process = session.process;
      if (event.event === "result" && process) {
        failEverythingPending(session, emit, process, {
          message: `Antigravity sent a result that could not be decoded (${event.reason})`,
          code: "agy_protocol",
        });
      }
      return;
    }
    case "unknown":
      console.log(`[antigravity] ignoring an ${event.event} event this plugin does not know`);
      return;
  }
}

export function handleStepUpdate(session: Session, step: AgyStepUpdate, emit: Emit): void {
  // A streamed answer is one step reported once per chunk: only what is not a chunk is worth a line.
  if (!step.text_delta) {
    console.log(
      `[antigravity] step idx=${step.step_index} ${step.state} ${step.step_type}` +
        `${step.tool_name ? ` tool=${step.tool_name}` : ""}`,
    );
  }

  const turn = session.pendingTurns[0];
  if (turn) {
    // The transcript already supplied this step while the stream was held; publishing the
    // stream's own copy now would only repeat it, and an assistant row would repeat its text.
    if (turn.backfilled.has(step.step_index)) return;
    if (step.step_index > turn.lastStreamStep) turn.lastStreamStep = step.step_index;
    if (turn.firstStep < 0 || step.step_index < turn.firstStep) turn.firstStep = step.step_index;
  }

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
      // A schema turn streams nothing to Paseo. Paseo maps every assistant snapshot to a *delta*
      // appended to its message, so a row streamed now and replaced by the decoded JSON on the
      // result would show both texts joined; the buffer is published once instead (`handleResult`,
      // `publishBufferedAnswer`). Tool rows are unaffected: they are not text-merged.
      if (!turn.schema) {
        publish(session, emit, {
          type: "assistant_message",
          id: itemId(turn, step.step_index, "msg"),
          text,
        });
      }
    }
    return;
  }

  // A step is reported twice when it spawns children: first as the `tool` line that called
  // `invoke_subagent`, then as a `subagent` line with the conversations it started. Both describe
  // the same rows, so both come here and merge into whatever the rows already hold.
  if (step.step_type === STEP_SUBAGENT) {
    if (!turn) {
      console.error(
        `[antigravity] dropping a subagent step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    handleSubagentStep(
      session,
      step,
      turn,
      step.tool_name ?? step.tool_info?.name ?? INVOKE_SUBAGENT,
      emit,
    );
    return;
  }

  if (step.step_type === STEP_TOOL) {
    if (!turn) {
      console.error(
        `[antigravity] dropping a tool step that belongs to no pending turn (idx=${step.step_index})`,
      );
      return;
    }
    const name = step.tool_name ?? step.tool_info?.name ?? "tool";
    // `invoke_subagent` is the one tool whose call is not the whole story: the children it spawned
    // keep running after the call reports DONE, so its rows are published and settled elsewhere.
    if (name === INVOKE_SUBAGENT) {
      handleSubagentStep(session, step, turn, name, emit);
      return;
    }
    const callId = itemId(turn, step.step_index, "tool");
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
    if (!turn.schema) scheduleBackfill(session, turn, emit);
    if (target) turn.snapshots.set(callId, readSnapshot(target));
    publish(session, emit, { type: "tool_call", ...tool, status: "running", error: null });
    return;
  }

  // `user_input` is published by the provider with its clientMessageId, and `system_message`
  // carries no user-facing content, so neither becomes a timeline row.
}

export function handleResult(session: Session, result: AgyResult, emit: Emit): void {
  const turn = session.pendingTurns.shift() ?? null;
  if (turn) stopBackfill(turn);
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
    if (turn.schema) {
      if (result.structured_output !== undefined) {
        // The decoded answer is the turn's only assistant row. agy's `response` repeats the same
        // JSON with `toolAction`/`toolSummary` added, so it must never be published, and the
        // streamed prose was never published either (see `handleStepUpdate`).
        const json = JSON.stringify(result.structured_output);
        publish(session, emit, {
          type: "assistant_message",
          id: `agy:schema:${turn.turnId}`,
          text: json ?? "",
        });
      } else {
        // A schema process that decoded nothing: what it said is published now, or the result's
        // own text when it streamed none.
        publishBufferedAnswer(session, emit, turn, response);
      }
    } else if (!turn.hadAssistantText && response.trim().length > 0) {
      // Safety net: agy answered without streaming any assistant text.
      publish(session, emit, {
        type: "assistant_message",
        id: `agy:result:${turn.turnId}`,
        text: response,
      });
    }
    // A subagent row is left running by its step, because the child it names outlives the call.
    // The turn ending is what closes the books: whatever the stream never settled is done as far
    // as this turn is concerned, and a child still followed keeps following until it finishes.
    finalizeToolCalls(session, emit, turn, { status: "completed" });
    emit({ type: "session.turn", sessionId: session.sessionId, turnId: turn.turnId, state: "completed" });
    if (!turn.schema) offerPlan(session, emit, turn, lastAssistantText(turn) || response);
    startNextPending(session, emit);
    return;
  }

  // agy reports an interrupt as a failed result with a fixed error string, and the user asking for
  // one is what says that is what this is, so the words agy chose are not the only thing judged.
  const interrupted = isInterrupted(result) || session.interrupting;
  if (interrupted) {
    endTurn(session, emit, turn, { state: "canceled", error: { message: "Interrupted" } });
  } else {
    const { error, retryable } = turnFailure(session, {
      message: result.error ?? `Antigravity reported ${result.status}`,
      code: result.status,
    });
    endTurn(session, emit, turn, { state: "failed", error });
    if (retryable) emitUnavailableNotice(session, emit);
  }
  startNextPending(session, emit);
  // agy exits after an error result, and the exit is reported a moment later. A turn sent in that
  // moment would be written to a CLI that will never read it, so this one is not used again. What
  // is queued behind the turn that ended is left to the exit, which settles it.
  const process = session.process;
  if (process && session.pendingTurns.length === 0) retireProcess(session, process);
}

function toProviderUsage(usage: AgyUsage): ProviderUsage {
  const outputTokens = (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0);
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_tokens,
    outputTokens: outputTokens > 0 ? outputTokens : undefined,
  };
}
