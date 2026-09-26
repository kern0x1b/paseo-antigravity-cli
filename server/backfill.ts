import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./json";
import { decodeArgs, type TranscriptEntry } from "./subagents";
import { mapToolDetail } from "./tools";

/**
 * Recovers a turn whose stream-json output agy has stopped delivering.
 *
 * agy prints a turn's steps strictly in order, and a `run_command` that moved to the background
 * stays ACTIVE on the stream until that background task ends. Every step after it — and the turn's
 * `result` — is held back until then, while the conversation itself carries on and finishes
 * (probed with agy 1.2.10: a `sleep 40` sent to the background held three later steps for 40 s;
 * a dev server held them for good). The conversation's own transcript is written as the steps
 * happen, so it is what the plugin reads while the stream is stuck.
 *
 * Stream and transcript share step indices: an `agent_response` step on the stream is the
 * transcript's PLANNER_RESPONSE at the same index, and the k-th tool it called is the step at
 * `index + 1 + k`, whose GENERIC line is that call's result.
 */

const PLANNER_RESPONSE = "PLANNER_RESPONSE";
const GENERIC = "GENERIC";

/** Where agy writes a conversation's transcript. */
export function conversationTranscriptPath(conversationId: string): string {
  return join(
    homedir(),
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

export interface BackfillIds {
  message(stepIndex: number): string;
  tool(stepIndex: number): string;
}

export interface BackfillRow {
  /** The stream step this row stands for. */
  readonly stepIndex: number;
  readonly item: ProviderTimelineItem;
}

export interface Backfill {
  /** Every row the transcript justifies, in step order. */
  readonly rows: BackfillRow[];
  /**
   * The step holding the conversation's final answer, or null while it is still working: the last
   * PLANNER_RESPONSE, when it has text and no tool calls. What agy wrote after it about the
   * conversation itself — a notice, a checkpoint, an error — does not take the answer away.
   */
  readonly finalStep: number | null;
  readonly finalText: string;
  /**
   * An error agy wrote and nothing followed: the last step is an ERROR_MESSAGE and the model has
   * not answered since. agy retries a failed model call, so this is the last word only until
   * something newer arrives; the caller decides how long to wait for that.
   */
  readonly failure: { readonly step: number; readonly message: string } | null;
}

/** The step types whose text is about the conversation, not something the model said or did. */
const NOTICE_TYPES: ReadonlySet<string> = new Set(["SYSTEM_MESSAGE", "CHECKPOINT", "ERROR_MESSAGE"]);
const ERROR_MESSAGE = "ERROR_MESSAGE";

/** Renders a conversation transcript into rows keyed the way the stream keys the same steps. */
export function renderBackfill(
  entries: readonly TranscriptEntry[],
  ids: BackfillIds,
  cwd: string,
): Backfill {
  const byStep = new Map(entries.map((entry) => [entry.stepIndex, entry]));
  const sorted = [...byStep.values()].sort((left, right) => left.stepIndex - right.stepIndex);
  const rows: BackfillRow[] = [];

  for (const entry of sorted) {
    if (entry.type !== PLANNER_RESPONSE) continue;
    const content = entry.content ?? "";
    if (content.trim().length > 0) {
      rows.push({
        stepIndex: entry.stepIndex,
        item: { type: "assistant_message", id: ids.message(entry.stepIndex), text: content },
      });
    }
    entry.toolCalls.forEach((call, index) => {
      const stepIndex = entry.stepIndex + 1 + index;
      const result = byStep.get(stepIndex);
      const output = result?.type === GENERIC ? (result.content ?? "") : undefined;
      const { parameters } = decodeArgs(call.args);
      const id = ids.tool(stepIndex);
      const detail = mapToolDetail(
        call.name,
        { name: call.name, parameters, ...(output !== undefined ? { output } : {}) },
        cwd,
      );
      const base = {
        type: "tool_call" as const,
        id,
        callId: id,
        name: call.name,
        detail,
        metadata: { stepIndex, parameters: structuredClone(parameters) as JsonValue },
      };
      // The result's own status is the tool's: a command moved to the background reports its
      // result as RUNNING and only the notice of its end says more, and a failed call says ERROR.
      const running = output === undefined || result?.status === "RUNNING";
      const failed = result?.status === "ERROR";
      const message = output !== undefined && output.length > 0 ? output : "The tool reported an error";
      rows.push({
        stepIndex,
        item: failed
          ? { ...base, status: "failed", error: { message } }
          : { ...base, status: running ? "running" : "completed", error: null },
      });
    });
  }

  const planner = sorted.findLast((entry) => entry.type === PLANNER_RESPONSE);
  const after = planner === undefined ? sorted : sorted.filter((entry) => entry.stepIndex > planner.stepIndex);
  const done =
    planner !== undefined &&
    planner.toolCalls.length === 0 &&
    (planner.content ?? "").trim().length > 0 &&
    after.every((entry) => NOTICE_TYPES.has(entry.type));
  const lastStep = sorted.at(-1);
  const failure =
    !done && lastStep !== undefined && lastStep.type === ERROR_MESSAGE
      ? { step: lastStep.stepIndex, message: lastStep.error ?? "Antigravity reported an error" }
      : null;
  return {
    rows,
    finalStep: done ? planner.stepIndex : null,
    finalText: done ? (planner.content ?? "") : "",
    failure,
  };
}

const USER_INPUT = "USER_INPUT";

/**
 * The steps past `settledStep` that nobody prompted: what the agent did on its own after a turn
 * ended, up to (not including) the next USER_INPUT, whose steps belong to that prompt's turn.
 */
export function stepsPast(entries: readonly TranscriptEntry[], settledStep: number): TranscriptEntry[] {
  const sorted = entries
    .filter((entry) => entry.stepIndex > settledStep)
    .sort((left, right) => left.stepIndex - right.stepIndex);
  const prompted = sorted.findIndex((entry) => entry.type === USER_INPUT);
  return prompted === -1 ? sorted : sorted.slice(0, prompted);
}

/**
 * Whether the model has done anything in these steps: answered, or called a tool. A step agy wrote
 * about the conversation instead — the notice of a finished or canceled task, a checkpoint, an
 * error — does not wake the model by itself, and a run of only those is not a turn.
 */
export function modelActed(steps: readonly TranscriptEntry[]): boolean {
  return steps.some((entry) => entry.type === PLANNER_RESPONSE);
}
