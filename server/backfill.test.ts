import { describe, expect, it } from "vitest";
import { backgroundTasks, renderBackfill, stepsPast } from "./backfill";
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

describe("backgroundTasks", () => {
  it("tracks started background tasks and removes finished ones", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 0, type: "USER_INPUT", content: "run job" }),
      entry({ stepIndex: 1, type: "GENERIC", content: "Tool is running as a background task with task id: conv/task-1" }),
      entry({ stepIndex: 2, type: "GENERIC", content: "Tool is running as a background task with task id: conv/task-2" }),
      entry({ stepIndex: 3, type: "SYSTEM_MESSAGE", content: 'Task id "conv/task-1" finished with result:\nOutput: ok' }),
    ];

    const tasks = backgroundTasks(entries, 2);
    expect(tasks.started).toBe(2);
    expect(tasks.open.size).toBe(1);
    expect(tasks.open.has("conv/task-2")).toBe(true);
    expect(tasks.open.has("conv/task-1")).toBe(false);
  });

  it("reports zero open tasks when all tasks finish or are canceled", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 0, type: "USER_INPUT", content: "run job" }),
      entry({ stepIndex: 1, type: "GENERIC", content: "Tool is running as a background task with task id: task-a" }),
      entry({ stepIndex: 2, type: "SYSTEM_MESSAGE", content: 'Task id "task-a" canceled' }),
    ];

    const tasks = backgroundTasks(entries, 1);
    expect(tasks.started).toBe(1);
    expect(tasks.open.size).toBe(0);
  });

  it("scopes task counting to the prompt at or before settledStep", () => {
    const entries: TranscriptEntry[] = [
      entry({ stepIndex: 0, type: "USER_INPUT", content: "old prompt" }),
      entry({ stepIndex: 1, type: "GENERIC", content: "Tool is running as a background task with task id: old-task" }),
      entry({ stepIndex: 2, type: "USER_INPUT", content: "new prompt" }),
      entry({ stepIndex: 3, type: "GENERIC", content: "Tool is running as a background task with task id: new-task" }),
    ];

    const tasks = backgroundTasks(entries, 3);
    expect(tasks.started).toBe(1);
    expect(tasks.open.has("new-task")).toBe(true);
    expect(tasks.open.has("old-task")).toBe(false);
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
