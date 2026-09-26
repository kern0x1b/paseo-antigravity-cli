import { describe, expect, it } from "vitest";
import { modelActed, renderBackfill, stepsPast } from "./backfill";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTranscriptLines, type TranscriptEntry } from "./subagents";

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

const ids = { message: (index: number) => `msg-${index}`, tool: (index: number) => `tool-${index}` };
const render = (entries: TranscriptEntry[]) => renderBackfill(entries, ids, "/test");

describe("renderBackfill", () => {
  it("renders assistant messages and tools from entries", () => {
    const rendered = render([
      entry({ stepIndex: 0, type: "USER_INPUT", content: "hello" }),
      entry({ stepIndex: 1, type: "PLANNER_RESPONSE", content: "Sure, let me check." }),
      entry({ stepIndex: 2, type: "PLANNER_RESPONSE", content: "Done!" }),
    ]);

    expect(rendered.rows.length).toBeGreaterThan(0);
    expect(rendered.finalStep).toBe(2);
    expect(rendered.finalText).toBe("Done!");
  });

  describe("the final answer", () => {
    const answer = entry({ stepIndex: 5, type: "PLANNER_RESPONSE", status: "DONE", content: "All done." });

    it("is the last planner response even when agy wrote a notice after it", () => {
      const rendered = render([
        answer,
        entry({ stepIndex: 6, type: "SYSTEM_MESSAGE", status: "DONE", content: "[Message] sender=c/task-1" }),
      ]);
      expect(rendered.finalStep).toBe(5);
      expect(rendered.finalText).toBe("All done.");
    });

    it("is not moved by a checkpoint or an error written after it", () => {
      const rendered = render([
        answer,
        entry({ stepIndex: 6, type: "CHECKPOINT", status: "DONE", content: "# Resuming from a compaction" }),
        entry({ stepIndex: 7, type: "ERROR_MESSAGE", status: "DONE", error: "API error (attempt 1)" }),
      ]);
      expect(rendered.finalStep).toBe(5);
      expect(rendered.failure).toBeNull();
    });

    it("does not exist while the last planner response still has tool calls", () => {
      const rendered = render([
        entry({ stepIndex: 4, type: "PLANNER_RESPONSE", content: "Earlier text." }),
        entry({
          stepIndex: 5,
          type: "PLANNER_RESPONSE",
          content: "Running it.",
          toolCalls: [{ name: "run_command", args: {} }],
        }),
      ]);
      expect(rendered.finalStep).toBeNull();
    });

    it("does not exist when the last planner response has no text", () => {
      const rendered = render([answer, entry({ stepIndex: 6, type: "PLANNER_RESPONSE", content: "" })]);
      expect(rendered.finalStep).toBeNull();
    });

    it("is found whatever order the lines were written in", () => {
      const rendered = render([
        entry({ stepIndex: 7, type: "SYSTEM_MESSAGE", status: "DONE" }),
        answer,
        entry({ stepIndex: 3, type: "USER_INPUT", content: "go" }),
      ]);
      expect(rendered.finalStep).toBe(5);
    });
  });

  describe("a failure", () => {
    it("is an error that is the last word, with the message agy gave", () => {
      const rendered = render([
        entry({ stepIndex: 1, type: "PLANNER_RESPONSE", toolCalls: [{ name: "run_command", args: {} }] }),
        entry({ stepIndex: 2, type: "GENERIC", status: "RUNNING", content: "Tool is running as a background task" }),
        entry({ stepIndex: 3, type: "ERROR_MESSAGE", status: "DONE", error: "API error (attempt 8): RESOURCE_EXHAUSTED (code 429)" }),
      ]);
      expect(rendered.finalStep).toBeNull();
      expect(rendered.failure).toEqual({ step: 3, message: "API error (attempt 8): RESOURCE_EXHAUSTED (code 429)" });
    });

    it("is none once the model has carried on after the error", () => {
      const rendered = render([
        entry({ stepIndex: 1, type: "ERROR_MESSAGE", status: "DONE", error: "model output error: retried" }),
        entry({ stepIndex: 2, type: "PLANNER_RESPONSE", toolCalls: [{ name: "run_command", args: {} }] }),
      ]);
      expect(rendered.failure).toBeNull();
    });
  });

  describe("a tool's row", () => {
    const call = entry({
      stepIndex: 1,
      type: "PLANNER_RESPONSE",
      toolCalls: [{ name: "run_command", args: { CommandLine: '"npm start"' } }],
    });
    const rowFor = (result?: TranscriptEntry) =>
      render(result ? [call, result] : [call]).rows.find((row) => row.stepIndex === 2)?.item;

    it("is running until its result is there", () => {
      expect(rowFor()).toMatchObject({ type: "tool_call", status: "running" });
    });

    it("is running while agy still reports the result as RUNNING, as it does for a background command", () => {
      expect(rowFor(entry({ stepIndex: 2, type: "GENERIC", status: "RUNNING", content: "started" }))).toMatchObject({
        status: "running",
      });
    });

    it("is completed at a DONE result", () => {
      expect(rowFor(entry({ stepIndex: 2, type: "GENERIC", status: "DONE", content: "ok" }))).toMatchObject({
        status: "completed",
      });
    });

    it("is failed at an ERROR result, with what agy said", () => {
      expect(rowFor(entry({ stepIndex: 2, type: "GENERIC", status: "ERROR", content: "permission denied" }))).toMatchObject({
        status: "failed",
        error: { message: "permission denied" },
      });
    });
  });

  describe("on a captured transcript", () => {
    const captured = parseTranscriptLines(
      readFileSync(fileURLToPath(new URL("../fixtures/13-background-tasks.transcript.jsonl", import.meta.url)), "utf8"),
    ).entries;

    it("shows the command that started a task as running, and the model's answer as final", () => {
      const rendered = render(captured.filter((item) => item.stepIndex <= 3));
      expect(rendered.rows.find((row) => row.stepIndex === 2)?.item).toMatchObject({ type: "tool_call", status: "running" });
      expect(rendered.finalStep).toBe(3);
      expect(rendered.finalText).toContain("started the test suite");
    });

    it("renders the model's own check on a task, and its kill, as tool rows that finished", () => {
      const rendered = render(captured.filter((item) => item.stepIndex >= 10 && item.stepIndex <= 16));
      const kill = rendered.rows.find((row) => row.stepIndex === 14)?.item;
      // A `manage_task` call has no diff or command to show, but it must not vanish or crash.
      expect(kill).toMatchObject({ type: "tool_call", name: "manage_task" });
      expect(rendered.finalStep).toBe(16);
    });

    it("finds the last answer through a checkpoint, an error and a notice written after it", () => {
      const rendered = render(captured.filter((item) => item.stepIndex >= 5 && item.stepIndex <= 9));
      expect(rendered.finalStep).toBe(7);
    });
  });
});
