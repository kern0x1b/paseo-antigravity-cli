import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptReader, TranscriptTailer } from "./tail";
import type { TranscriptEntry } from "./subagents";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "antigravity-tail-"));
  path = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function line(stepIndex: number, type = "PLANNER_RESPONSE", extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ step_index: stepIndex, source: "MODEL", type, status: "DONE", ...extra })}\n`;
}

const steps = (entries: readonly TranscriptEntry[]): number[] => entries.map((entry) => entry.stepIndex);

describe("TranscriptReader", () => {
  it("reads only what was appended since the last read", async () => {
    writeFileSync(path, line(0, "USER_INPUT") + line(1));
    const reader = new TranscriptReader(path);
    expect(await reader.read()).toMatchObject({ grew: true, changed: true });
    expect(steps(reader.entries())).toEqual([0, 1]);
    const consumed = reader.bytesRead;

    expect(await reader.read()).toMatchObject({ grew: false, changed: false });
    appendFileSync(path, line(2));
    expect(await reader.read()).toMatchObject({ grew: true, changed: true });
    expect(steps(reader.entries())).toEqual([0, 1, 2]);
    // The second line's bytes were read once: the offset moved by exactly what was appended.
    expect(reader.bytesRead - consumed).toBe(Buffer.byteLength(line(2)));
  });

  it("keeps a half-written line until its newline arrives instead of losing it", async () => {
    const whole = line(1, "PLANNER_RESPONSE", { content: "the final answer" });
    writeFileSync(path, line(0, "USER_INPUT") + whole.slice(0, 30));
    const reader = new TranscriptReader(path);
    await reader.read();
    expect(steps(reader.entries())).toEqual([0]);
    expect(reader.malformed).toBe(0);

    appendFileSync(path, whole.slice(30));
    await reader.read();
    expect(reader.entries().at(-1)).toMatchObject({ stepIndex: 1, content: "the final answer" });
    expect(reader.malformed).toBe(0);
  });

  it("delivers a last line that only gets its newline later", async () => {
    writeFileSync(path, line(0, "USER_INPUT") + line(1).trimEnd());
    const reader = new TranscriptReader(path);
    await reader.read();
    expect(steps(reader.entries())).toEqual([0]);
    appendFileSync(path, "\n");
    await reader.read();
    expect(steps(reader.entries())).toEqual([0, 1]);
  });

  it("does not split a multi-byte character that straddles two reads", async () => {
    const bytes = Buffer.from(line(1, "PLANNER_RESPONSE", { content: "готово ✔" }));
    const split = bytes.indexOf(Buffer.from("✔")) + 1;
    writeFileSync(path, bytes.subarray(0, split));
    const reader = new TranscriptReader(path);
    await reader.read();
    appendFileSync(path, bytes.subarray(split));
    await reader.read();
    expect(reader.entries()).toMatchObject([{ stepIndex: 1, content: "готово ✔" }]);
    expect(reader.malformed).toBe(0);
  });

  it("keeps a tool result that is written before the step that called it", async () => {
    // Real transcripts do this: step 6 (the result) precedes step 5 (the call) in the file.
    writeFileSync(path, line(6, "GENERIC", { content: "result" }));
    const reader = new TranscriptReader(path);
    await reader.read();
    appendFileSync(path, line(5, "PLANNER_RESPONSE", { tool_calls: [{ name: "run_command", args: {} }] }));
    await reader.read();
    expect(steps(reader.entries())).toEqual([5, 6]);
  });

  it("takes the later line when a step is written again", async () => {
    writeFileSync(path, line(2, "GENERIC", { status: "RUNNING", content: "running" }));
    const reader = new TranscriptReader(path);
    await reader.read();
    appendFileSync(path, line(2, "GENERIC", { status: "DONE", content: "done" }));
    await reader.read();
    expect(reader.entries()).toMatchObject([{ stepIndex: 2, status: "DONE", content: "done" }]);
  });

  it("counts lines that are not steps instead of dropping the file", async () => {
    writeFileSync(path, `not json\n${line(1)}{"no_step_index":true}\n`);
    const reader = new TranscriptReader(path);
    await reader.read();
    expect(steps(reader.entries())).toEqual([1]);
    expect(reader.malformed).toBe(2);
  });

  it("follows a transcript past 32 MiB", async () => {
    const filler = "x".repeat(1000);
    const chunk = Array.from({ length: 1000 }, (_unused, index) => line(index, "GENERIC", { content: filler })).join("");
    // 35 MiB of steps that came first, then the step this test is about.
    for (let round = 0; round < 35; round += 1) appendFileSync(path, chunk);
    appendFileSync(path, line(50_000, "PLANNER_RESPONSE", { content: "the answer, far past 32 MiB" }));

    const reader = new TranscriptReader(path, { fromStep: 50_000 });
    await reader.read();
    expect(reader.bytesRead).toBeGreaterThan(32 * 1024 * 1024);
    expect(reader.entries()).toMatchObject([{ stepIndex: 50_000, content: "the answer, far past 32 MiB" }]);
  });

  it("holds only the steps from the one it was told to start at", async () => {
    writeFileSync(path, line(0, "USER_INPUT") + line(1) + line(2, "GENERIC") + line(3));
    const reader = new TranscriptReader(path, { fromStep: 2 });
    await reader.read();
    expect(steps(reader.entries())).toEqual([2, 3]);
    expect(reader.malformed).toBe(0);
  });

  it("starts over when the file shrinks, which is a different file", async () => {
    writeFileSync(path, line(0, "USER_INPUT") + line(1) + line(2));
    const reader = new TranscriptReader(path);
    await reader.read();
    truncateSync(path, 0);
    writeFileSync(path, line(7, "USER_INPUT"));
    await reader.read();
    expect(steps(reader.entries())).toEqual([7]);
  });

  it("finds nothing, and does not throw, while the file does not exist yet", async () => {
    const reader = new TranscriptReader(join(dir, "missing", "transcript.jsonl"));
    expect(await reader.read()).toMatchObject({ grew: false, changed: false });
    mkdirSync(join(dir, "missing"));
    writeFileSync(join(dir, "missing", "transcript.jsonl"), line(0, "USER_INPUT"));
    expect(await reader.read()).toMatchObject({ changed: true });
  });

  it("rejects when the file cannot be read", async () => {
    const reader = new TranscriptReader(dir);
    await expect(reader.read()).rejects.toThrow();
  });

  it("gives two overlapping reads the same result instead of reading twice", async () => {
    writeFileSync(path, line(0, "USER_INPUT") + line(1));
    const reader = new TranscriptReader(path);
    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    expect(second).toBe(first);
    expect(reader.bytesRead).toBe(Buffer.byteLength(line(0, "USER_INPUT") + line(1)));
  });
});

describe("TranscriptTailer", () => {
  function tail(handlers: { changes: TranscriptEntry[][]; errors: string[] }, options = {}) {
    const reader = new TranscriptReader(path, options);
    return new TranscriptTailer(
      reader,
      {
        onChange: (entries) => handlers.changes.push([...entries]),
        onError: (reason) => handlers.errors.push(reason),
      },
      10,
    );
  }

  async function until(check: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("hands on the entries when the file grows, and only then", async () => {
    const seen = { changes: [] as TranscriptEntry[][], errors: [] as string[] };
    writeFileSync(path, line(0, "USER_INPUT"));
    const tailer = tail(seen);
    tailer.start();
    try {
      await until(() => seen.changes.length === 1, "the first read");
      appendFileSync(path, line(1));
      await until(() => seen.changes.length === 2, "the appended step");
      expect(steps(seen.changes[1] ?? [])).toEqual([0, 1]);
      // The file stays as it is for a while; nothing more is delivered for it.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(seen.changes).toHaveLength(2);
    } finally {
      tailer.stop();
    }
  });

  it("reads once more on demand and delivers that before it resolves", async () => {
    const seen = { changes: [] as TranscriptEntry[][], errors: [] as string[] };
    writeFileSync(path, line(0, "USER_INPUT"));
    const tailer = tail(seen);
    // Never started: what a caller that is about to stop it wants is the last read.
    await tailer.drain();
    expect(steps(seen.changes.at(-1) ?? [])).toEqual([0]);
  });

  it("reports a file it cannot read to its owner after repeated failures, once, and stops", async () => {
    const seen = { changes: [] as TranscriptEntry[][], errors: [] as string[] };
    const reader = new TranscriptReader(dir);
    const tailer = new TranscriptTailer(
      reader,
      { onChange: () => undefined, onError: (reason) => seen.errors.push(reason) },
      5,
    );
    tailer.start();
    await until(() => seen.errors.length > 0, "the failure to be reported");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toContain(dir);
  });

  it("delivers nothing after it is stopped", async () => {
    const seen = { changes: [] as TranscriptEntry[][], errors: [] as string[] };
    writeFileSync(path, line(0, "USER_INPUT"));
    const tailer = tail(seen);
    tailer.start();
    await until(() => seen.changes.length === 1, "the first read");
    tailer.stop();
    appendFileSync(path, line(1));
    await tailer.drain();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seen.changes).toHaveLength(1);
  });
});
