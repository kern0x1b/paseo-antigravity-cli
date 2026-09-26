import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The fake agy is only as good as its likeness to the real one. Its transcript lines are compared
 * here with a sample captured from agy 1.2.11 (fixtures/13-background-tasks.transcript.jsonl, ids
 * and paths anonymised): every line the fake writes must have the shape of a line agy wrote, so a
 * fake that drifts — wording, fields, statuses — fails here instead of quietly teaching the plugin
 * something agy never does. A fake that had always written `Task id "task-1" finished` bare would
 * have failed this way, and is what let the first background-task detection ship wrong.
 */

const fakeAgy = fileURLToPath(new URL("./fake-agy.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../fixtures/13-background-tasks.transcript.jsonl", import.meta.url));
const CONVERSATION = "cafe0000-1111-4222-8333-444455556666";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-fake-"));
  chmodSync(fakeAgy, 0o755);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TIMESTAMP = /\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?/g;

/** A line without what varies from run to run: ids, times, paths, numbers, the model's own words. */
function shapeOf(line: Record<string, unknown>): string {
  const optional = new Set(["thinking", "truncated_fields"]);
  const keys = Object.keys(line).filter((key) => !optional.has(key)).sort().join(",");
  const type = String(line.type);
  const status = String(line.status);
  const source = String(line.source);
  // Only lines agy writes itself have wording of its own; the model's and the user's vary.
  const generated = (type === "GENERIC" && status === "RUNNING") || type === "SYSTEM_MESSAGE";
  const skeleton = generated ? skeletonOf(String(line.content ?? "")) : "";
  return `${type}|${status}|${source}|${keys}|${skeleton}`;
}

/**
 * What agy's own words look like once the parts that vary are masked. A notice ends at
 * `with result:`: what follows is the command's output, or the reason a task was canceled.
 */
function skeletonOf(content: string): string {
  const masked = content
    .split("\n")
    .map((text) =>
      text
        .replace(UUID, "<CONVERSATION>")
        .replace(TIMESTAMP, "<TIME>")
        .replace(/file:\/\/\S+/g, "<URI>")
        .replace(/task-\d+/g, "task-N")
        .replace(/(?<=Task Description: ).*/, "<COMMAND>"),
    )
    .filter((text) => text.trim().length > 0);
  const end = masked.findIndex((text) => text.endsWith("with result:"));
  return (end === -1 ? masked.slice(0, 8) : masked.slice(0, end + 1)).join("¶");
}

function linesOf(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Runs one turn of a scenario to its result, with every gate already open, and returns what it wrote. */
async function transcriptOf(scenario: string, ending: string): Promise<Record<string, unknown>[]> {
  const gates = join(home, "gates");
  mkdirSync(gates, { recursive: true });
  const gate = join(gates, "open");
  writeFileSync(gate, "");
  const child = spawn(fakeAgy, ["--input-format", "stream-json"], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      FAKE_SCENARIO: scenario,
      FAKE_BACKGROUND_END: ending,
      FAKE_BACKGROUND_GATE: gate,
      FAKE_BACKGROUND_FINAL_GATE: gate,
      FAKE_CONVERSATION_ID: CONVERSATION,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const done = Promise.withResolvers<void>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.includes('"event":"result"') && buffer.endsWith("\n")) done.resolve();
  });
  child.stdin.write(
    `${JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`,
  );
  await done.promise;
  child.kill("SIGKILL");
  return linesOf(join(home, ".gemini", "antigravity-cli", "brain", CONVERSATION, ".system_generated", "logs", "transcript.jsonl"));
}

describe("the fake agy", () => {
  const real = new Set(linesOf(fixture).map(shapeOf));

  /**
   * What each ending has to have written, by the kind of line: the likeness check alone would pass a
   * fake that wrote nothing the plugin has to understand. `contains` is a phrase of agy's own.
   */
  const CASES = [
    { ending: "never", kinds: ["GENERIC|RUNNING|MODEL"], contains: [] },
    { ending: "finish", kinds: ["GENERIC|RUNNING|MODEL", "SYSTEM_MESSAGE|DONE|SYSTEM"], contains: ["finished with result:"] },
    { ending: "canceled", kinds: ["GENERIC|RUNNING|MODEL", "SYSTEM_MESSAGE|DONE|SYSTEM"], contains: ["was canceled with result:"] },
    { ending: "trailing", kinds: ["CHECKPOINT|DONE|SYSTEM", "SYSTEM_MESSAGE|DONE|SYSTEM"], contains: ["was canceled with result:"] },
    { ending: "error-recovers", kinds: ["GENERIC|RUNNING|MODEL", "ERROR_MESSAGE|DONE|SYSTEM"], contains: [] },
  ] as const;

  for (const { ending, kinds, contains } of CASES) {
    it(`writes transcript lines shaped like real ones, and the ones the plugin has to read (${ending})`, async () => {
      const written = await transcriptOf("background", ending);
      expect(written.length).toBeGreaterThan(2);
      const unfamiliar = written.map(shapeOf).filter((shape) => !real.has(shape));
      expect(unfamiliar).toEqual([]);

      const shapes = written.map(shapeOf);
      for (const kind of kinds) expect(shapes.some((shape) => shape.startsWith(`${kind}|`))).toBe(true);
      const text = written.map((entry) => String(entry.content ?? "")).join("\n");
      for (const phrase of contains) expect(text).toContain(phrase);
    });
  }

  it("has a sample to compare with that includes every kind of line it needs", () => {
    const kinds = new Set([...real].map((shape) => shape.split("|").slice(0, 3).join("|")));
    for (const wanted of [
      "GENERIC|RUNNING|MODEL",
      "SYSTEM_MESSAGE|DONE|SYSTEM",
      "PLANNER_RESPONSE|DONE|MODEL",
      "USER_INPUT|DONE|USER_EXPLICIT",
      "ERROR_MESSAGE|DONE|SYSTEM",
      "CHECKPOINT|DONE|SYSTEM",
    ]) {
      expect(kinds).toContain(wanted);
    }
  });
});
