import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTranscriptLines, type TranscriptEntry } from "./subagents";
import { openBackgroundTasks, parseSystemMessages, startedTaskId } from "./tasks";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

/** The conversation of fixtures/13-background-tasks.transcript.jsonl, ids anonymised. */
const CONVERSATION = "9d3c1f5e-2a4b-4c6d-8e7f-0a1b2c3d4e5f";
const task = (n: number): string => `${CONVERSATION}/task-${n}`;

function captured(): TranscriptEntry[] {
  const parsed = parseTranscriptLines(
    readFileSync(`${fixturesDir}/13-background-tasks.transcript.jsonl`, "utf8"),
  );
  expect(parsed.malformed).toBe(0);
  return parsed.entries;
}

function entry(overrides: Partial<TranscriptEntry> & { stepIndex: number; type: string }): TranscriptEntry {
  return { toolCalls: [], ...overrides };
}

/** A SYSTEM_MESSAGE entry as agy wraps it: the envelope, then one `[Message]` header line. */
function systemMessage(stepIndex: number, sender: string, priority: string, content: string): TranscriptEntry {
  return entry({
    stepIndex,
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-26T12:23:40Z sender=${sender} priority=MESSAGE_PRIORITY_${priority} content=${content}\n</SYSTEM_MESSAGE>`,
  });
}

function taskStart(stepIndex: number, id: string, description = "npm test"): TranscriptEntry {
  return entry({
    stepIndex,
    type: "GENERIC",
    status: "RUNNING",
    content: `Created At: 2026-09-26T14:22:46+02:00\nTool is running as a background task with task id: ${id}\nTask Description: ${description}\nTask logs are available at: file:///tmp/${id}.log\n`,
  });
}

describe("parseTranscriptLines", () => {
  it("keeps the status and source agy writes on every step", () => {
    const entries = captured();
    const start = entries.find((item) => item.stepIndex === 2);
    expect(start).toMatchObject({ type: "GENERIC", status: "RUNNING", source: "MODEL" });
    const message = entries.find((item) => item.stepIndex === 4);
    expect(message).toMatchObject({ type: "SYSTEM_MESSAGE", status: "DONE", source: "SYSTEM" });
  });
});

describe("parseSystemMessages", () => {
  it("reads the sender and priority from the [Message] header of a captured notice", () => {
    const finished = captured().find((item) => item.stepIndex === 4);
    expect(parseSystemMessages(finished?.content ?? "")).toEqual([
      expect.objectContaining({ sender: task(2), priority: "MESSAGE_PRIORITY_HIGH" }),
    ]);
  });

  it("reads several messages batched into one entry", () => {
    const content = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-26T12:23:40Z sender=${task(1)} priority=MESSAGE_PRIORITY_HIGH content=first\n[Message] timestamp=2026-09-26T12:23:41Z sender=${task(2)} priority=MESSAGE_PRIORITY_LOW content=second\n</SYSTEM_MESSAGE>`;
    expect(parseSystemMessages(content).map((message) => message.sender)).toEqual([task(1), task(2)]);
  });

  it("finds nothing in text that only mentions the format", () => {
    expect(parseSystemMessages("a file that quotes [Message] timestamp=x sender=y priority=z")).toEqual([]);
  });
});

describe("startedTaskId", () => {
  it("names the task a running GENERIC step started", () => {
    expect(startedTaskId(taskStart(2, task(2)))).toBe(task(2));
  });

  it("ignores a finished step that merely shows the same text, such as a file that was read", () => {
    const quoted = { ...taskStart(9, task(9)), status: "DONE" };
    expect(startedTaskId(quoted)).toBeNull();
  });

  it("ignores the same line inside a model answer", () => {
    const answer = entry({
      stepIndex: 9,
      type: "PLANNER_RESPONSE",
      status: "RUNNING",
      content: `Tool is running as a background task with task id: ${task(9)}`,
    });
    expect(startedTaskId(answer)).toBeNull();
  });
});

describe("openBackgroundTasks", () => {
  it("counts a task the turn started as open until something reports on it", () => {
    const upToAnswer = captured().filter((item) => item.stepIndex <= 3);
    expect([...openBackgroundTasks(upToAnswer, 3)]).toEqual([task(2)]);
  });

  it("closes a task at the notice agy sends when it finishes", () => {
    const entries = captured().filter((item) => item.stepIndex <= 7);
    expect(openBackgroundTasks(entries, 7).size).toBe(0);
  });

  it("closes a task the model canceled, whose notice reads `was canceled`", () => {
    const entries = captured().filter((item) => item.stepIndex <= 16);
    expect(openBackgroundTasks(entries, 16).size).toBe(0);
  });

  it("closes a timer at the message that carries its prompt, whatever the wording", () => {
    const entries = [
      entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }),
      taskStart(1, task(1), "Timer: 30s, Prompt: Check CI job 1043734 status"),
      systemMessage(2, task(1), "HIGH", "Check CI job 1043734 status"),
    ];
    expect(openBackgroundTasks(entries, 2).size).toBe(0);
  });

  it("closes a task at a notice worded in a way nobody has seen, because the sender is what names it", () => {
    const entries = [
      entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }),
      taskStart(1, task(1)),
      systemMessage(2, task(1), "HIGH", "Something agy may word differently one day"),
    ];
    expect(openBackgroundTasks(entries, 2).size).toBe(0);
  });

  it("keeps every task open that has not been reported on", () => {
    const entries = [
      entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }),
      taskStart(1, task(1)),
      taskStart(2, task(2)),
      systemMessage(3, task(1), "HIGH", `Task id "${task(1)}" finished with result:`),
    ];
    expect([...openBackgroundTasks(entries, 3)]).toEqual([task(2)]);
  });

  it("does not let a file that quotes the notice close a task", () => {
    const quoted = entry({
      stepIndex: 2,
      type: "GENERIC",
      status: "DONE",
      content: `File Path: \`file:///tmp/tasks.test.ts\`\n<SYSTEM_MESSAGE>\n[Message] timestamp=x sender=${task(1)} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task(1)}" finished with result:\n</SYSTEM_MESSAGE>`,
    });
    const entries = [entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }), taskStart(1, task(1)), quoted];
    expect([...openBackgroundTasks(entries, 2)]).toEqual([task(1)]);
  });

  it("does not let a file that quotes the start line open a task", () => {
    const quoted = { ...taskStart(1, task(1)), status: "DONE" };
    const entries = [entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }), quoted];
    expect(openBackgroundTasks(entries, 1).size).toBe(0);
  });

  it("counts only the tasks of the prompt at or before the settled step", () => {
    const entries = [
      entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }),
      taskStart(1, task(1)),
      entry({ stepIndex: 2, type: "USER_INPUT", status: "DONE" }),
      taskStart(3, task(3)),
    ];
    expect([...openBackgroundTasks(entries, 3)]).toEqual([task(3)]);
  });

  it("reads the notice of a step that was written before its predecessor", () => {
    // Fixture step 6 precedes step 5 in the file, which is how agy writes some turns.
    const entries = captured().filter((item) => item.stepIndex <= 7);
    expect(openBackgroundTasks(entries.reverse(), 7).size).toBe(0);
  });

  it("takes the notice agy sends when it restarts for a message from no task at all", () => {
    // A resumed conversation starts with `sender=system`: every task of the process before it is
    // gone, and none of them is this prompt's to wait for. It names no task, so it opens and closes
    // nothing, and a task from before the new prompt is out of scope anyway.
    const entries = captured();
    const notice = entries.find((item) => item.stepIndex === 22);
    expect(parseSystemMessages(notice?.content ?? "")).toEqual([
      expect.objectContaining({ sender: "system", priority: "MESSAGE_PRIORITY_LOW" }),
    ]);
    expect(openBackgroundTasks(entries, 23).size).toBe(0);
    // Even with a task left open before the new prompt.
    const withOpenTask = [entry({ stepIndex: 0, type: "USER_INPUT", status: "DONE" }), taskStart(1, task(1)), ...entries.filter((item) => item.stepIndex >= 21)].map((item, index) => ({ ...item, stepIndex: item.stepIndex + (index > 1 ? 100 : 0) }));
    expect(openBackgroundTasks(withOpenTask, 123).size).toBe(0);
  });
});
