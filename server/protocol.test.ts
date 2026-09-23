import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeUserTurn, isInterrupted, parseAgyLine, type AgyEvent } from "./protocol";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

function fixtureNames(): string[] {
  return readdirSync(fixturesDir).filter((name) => name.endsWith(".ndjson"));
}

function loadFixture(name: string): AgyEvent[] {
  const raw = readFileSync(`${fixturesDir}/${name}`, "utf8");
  const events: AgyEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const event = parseAgyLine(line);
    expect(event, `unparsed line in ${name}: ${line.slice(0, 120)}`).not.toBeNull();
    if (event) events.push(event);
  }
  return events;
}

describe("parseAgyLine", () => {
  it("ignores blank lines, decorated output, and malformed JSON", () => {
    expect(parseAgyLine("")).toBeNull();
    expect(parseAgyLine("   ")).toBeNull();
    expect(parseAgyLine("Fetching available models...")).toBeNull();
    expect(parseAgyLine("{not json")).toBeNull();
    expect(parseAgyLine("[1,2,3]")).toBeNull();
    expect(parseAgyLine('"a string"')).toBeNull();
    expect(parseAgyLine('{"no_event_field":true}')).toBeNull();
  });

  it("degrades to an unknown event instead of throwing on a payload it cannot decode", () => {
    expect(parseAgyLine('{"event":"something_new"}')).toEqual({
      kind: "unknown",
      event: "something_new",
    });
    // A known name with an unusable payload must not surface as a typed event.
    expect(parseAgyLine('{"event":"result","result":{"nope":true}}')).toEqual({
      kind: "unknown",
      event: "result",
    });
    expect(parseAgyLine('{"event":"step_update"}')).toEqual({
      kind: "unknown",
      event: "step_update",
    });
  });

  it("decodes init with its conversation id and tool list", () => {
    const event = parseAgyLine(
      '{"event":"init","conversation_id":"abc","init":{"cwd":"/tmp","tools":["run_command"],"permission_mode":"always-proceed"}}',
    );
    expect(event).toEqual({
      kind: "init",
      conversationId: "abc",
      cwd: "/tmp",
      tools: ["run_command"],
    });
  });

  it("encodes one user turn as a single NDJSON line with the event envelope", () => {
    const line = encodeUserTurn("hello");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
  });
});

describe("captured agy fixtures", () => {
  it("has fixtures on disk to exercise the decoder", () => {
    expect(fixtureNames().length).toBeGreaterThan(0);
  });

  it.each(fixtureNames())("%s decodes without loss and starts with init", (name) => {
    const events = loadFixture(name);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.kind).toBe("init");
    expect(events.some((event) => event.kind === "unknown")).toBe(false);

    const first = events[0];
    if (first?.kind === "init") {
      expect(first.conversationId).toMatch(/[0-9a-f-]{8,}/);
      expect(first.tools.length).toBeGreaterThan(0);
    }
  });

  it.each(fixtureNames())("%s ends with a terminal result event", (name) => {
    const events = loadFixture(name);
    expect(events.at(-1)?.kind).toBe("result");
  });

  it("carries tool steps with a canonical tool name and parameters", () => {
    const toolSteps = loadFixture("02-tool-calls.ndjson").flatMap((event) =>
      event.kind === "step_update" && event.step.step_type === "tool" ? [event.step] : [],
    );
    expect(toolSteps.length).toBeGreaterThan(0);

    const done = toolSteps.filter((step) => step.state === "DONE");
    expect(done.length).toBeGreaterThan(0);
    expect(done[0]?.tool_name).toBe("run_command");
    expect(done[0]?.tool_info?.parameters).toMatchObject({ CommandLine: expect.any(String) });
    expect(typeof done[0]?.tool_info?.output).toBe("string");
  });

  /**
   * The regression that matters most: text_delta is an incremental chunk, so the deltas for a
   * turn must concatenate back to the turn's reported response. If agy ever switches to
   * snapshots this fails loudly instead of silently duplicating text in Paseo.
   */
  it.each(fixtureNames())("%s streams deltas that rebuild each result response", (name) => {
    const events = loadFixture(name);
    let accumulated = "";
    let turns = 0;

    for (const event of events) {
      if (event.kind === "step_update" && event.step.step_type === "agent_response") {
        accumulated += event.step.text_delta ?? "";
        continue;
      }
      if (event.kind !== "result") continue;

      turns += 1;
      expect(accumulated, `turn ${turns} of ${name}`).toBe(event.result.response);
      accumulated = "";
    }

    expect(turns).toBeGreaterThan(0);
  });

  it("reports queued follow-up input as a separate turn, never as a steer", () => {
    const events = loadFixture("04-queued-second-line.ndjson");
    const results = events.filter((event) => event.kind === "result");
    expect(results.length).toBe(2);

    // The first turn runs to completion before the second input begins, which is why the
    // provider does not advertise prompt.steer.
    const firstResultIndex = events.findIndex((event) => event.kind === "result");
    const secondUserInputIndex = events.findIndex(
      (event, index) =>
        index > firstResultIndex &&
        event.kind === "step_update" &&
        event.step.step_type === "user_input",
    );
    expect(secondUserInputIndex).toBeGreaterThan(firstResultIndex);
  });

  it("recognises an interrupted turn as a cancellation rather than a failure", () => {
    // Captured from a real SIGINT: `error: interrupted` on stderr, then this result, then exit 1.
    expect(
      isInterrupted({ status: "ERROR", error: "interrupted", response: "", num_turns: 0 }),
    ).toBe(true);
    expect(
      isInterrupted({ status: "ERROR", error: "Eligibility check failed", num_turns: 0 }),
    ).toBe(false);
    expect(isInterrupted({ status: "SUCCESS", response: "ok" })).toBe(false);
  });
});
