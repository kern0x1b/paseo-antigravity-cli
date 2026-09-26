import { describe, expect, it } from "vitest";
import { modelActed, renderBackfill, stepsPast } from "./backfill";
import type { TranscriptEntry } from "./subagents";

function entry(overrides: Partial<TranscriptEntry> & { stepIndex: number; type: string }): TranscriptEntry {
  return { toolCalls: [], ...overrides };
}

describe("stepsPast", () => {
  it("returns steps with stepIndex > settledStep up to the next USER_INPUT", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 0, type: "USER_INPUT", content: "hello" }),
      entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "hi" }),
      entry({ stepIndex: 2, type: "GENERIC", content: "Tool is running as a background task with task id: task-1" }),
      entry({ stepIndex: 3, type: "SYSTEM_MESSAGE", content: 'Task id "task-1" finished with result:\ndone' }),
      entry({ stepIndex: 4, type: "PLANNER_RESPONSE", content: "continuation response" }),
      entry({ stepIndex: 5, type: "USER_INPUT", content: "next prompt" }),
      entry({ stepIndex: 6, type: "PLANNER_RESPONSE", content: "next response" }),
    ];

    // When settledStep is 2 (the background task was started, turn settled from transcript)
    const past = stepsPast(entries, 2);
    expect(past.map((e) => e.stepIndex)).toEqual([3, 4]);
  });

  it("returns all remaining steps if there is no subsequent USER_INPUT", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "hi" }),
      entry({ stepIndex: 2, type: "SYSTEM_MESSAGE", content: 'Task id "task-1" finished' }),
      entry({ stepIndex: 3, type: "PLANNER_RESPONSE", content: "all done" }),
    ];
    const past = stepsPast(entries, 1);
    expect(past.map((e) => e.stepIndex)).toEqual([2, 3]);
  });

  it("returns empty array if no steps past settledStep", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "hi" }),
    ];
    expect(stepsPast(entries, 1)).toEqual([]);
    expect(stepsPast(entries, 5)).toEqual([]);
  });
});

describe("modelActed", () => {
  it("is false while agy has only told the model something", () => {
    const past: TranscriptEntry[] = [
      entry({ stepIndex: 3, type: "SYSTEM_MESSAGE", status: "DONE", content: "[Message] sender=c/task-1 priority=MESSAGE_PRIORITY_LOW" }),
    ];
    expect(modelActed(past)).toBe(false);
  });

  it("is false for a checkpoint or an error that agy wrote by itself", () => {
    const past: TranscriptEntry[] = [
      entry({ stepIndex: 3, type: "CHECKPOINT", status: "DONE", content: "# Resuming from a compaction" }),
      entry({ stepIndex: 4, type: "ERROR_MESSAGE", status: "DONE" }),
    ];
    expect(modelActed(past)).toBe(false);
  });

  it("is true once the model answers or calls a tool", () => {
    const notice = entry({ stepIndex: 3, type: "SYSTEM_MESSAGE", status: "DONE" });
    expect(modelActed([notice, entry({ stepIndex: 4, type: "PLANNER_RESPONSE", content: "Done." })])).toBe(true);
    expect(
      modelActed([
        notice,
        entry({ stepIndex: 4, type: "PLANNER_RESPONSE", toolCalls: [{ name: "run_command", args: {} }] }),
      ]),
    ).toBe(true);
  });
});

describe("renderBackfill", () => {
  it("renders assistant messages and tools from entries", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 0, type: "USER_INPUT", content: "hello" }),
      entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "Sure, let me check." }),
      entry({
        stepIndex: 2,
        type: "PLANNER_RESPONSE",
        content: "Done!",
      }),
    ];

    const rendered = renderBackfill(
      entries,
      {
        message: (idx) => `msg-${idx}`,
        tool: (idx) => `tool-${idx}`,
      },
      "/test",
    );

    expect(rendered.rows.length).toBeGreaterThan(0);
    expect(rendered.finalStep).toBe(2);
    expect(rendered.finalText).toBe("Done!");
  });
});
