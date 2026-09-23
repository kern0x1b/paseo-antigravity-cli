import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProvider } from "./provider";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));
const OFFERED = [
  "prompt.message",
  "prompt.command",
  "prompt.steer",
  "session.configure",
  "session.persistence",
  "permission.tool_policy",
];

let tempDir: string;
let argvFile: string;
let promptFile: string;
let openConnections: ProviderConnection[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-provider-"));
  argvFile = join(tempDir, "argv.json");
  promptFile = join(tempDir, "prompts.jsonl");

  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  process.env.PASEO_HOME = join(tempDir, "paseo-home");
  process.env.FAKE_ARGV_FILE = argvFile;
  process.env.FAKE_PROMPT_FILE = promptFile;
  delete process.env.FAKE_SCENARIO;
  delete process.env.FAKE_MODELS_OK;
  openConnections = [];
});

afterEach(async () => {
  await Promise.all(openConnections.map((connection) => connection.close()));
  openConnections = [];
  for (const key of [
    "PASEO_ANTIGRAVITY_BIN",
    "PASEO_HOME",
    "FAKE_ARGV_FILE",
    "FAKE_PROMPT_FILE",
    "FAKE_SCENARIO",
    "FAKE_MODELS_OK",
    "FAKE_CONVERSATION_ID",
  ]) {
    delete process.env[key];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

interface Harness {
  connection: ProviderConnection;
  events: ProviderEvent[];
}

async function connect(): Promise<Harness> {
  const connection = await createProvider().connect({ versions: [1], capabilities: OFFERED });
  openConnections.push(connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  return { connection, events };
}

function sessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    cwd: tempDir,
    env: {},
    mcpServers: {},
    settings: {},
    model: "gemini-3.8-flash-high",
    mode: "default",
    thinkingOption: "medium",
    persist: true,
    ...overrides,
  };
}

async function openSession(
  connection: ProviderConnection,
  overrides: Partial<ProviderSessionConfig> = {},
  options: { sessionId?: string; history?: "replay" | "skip"; persistence?: ProviderPersistence } = {},
): Promise<void> {
  const input: ProviderInput = {
    type: "session.open",
    requestId: "open-1",
    sessionId: options.sessionId ?? "session-1",
    config: sessionConfig(overrides),
    history: options.history ?? "skip",
    ...(options.persistence ? { persistence: options.persistence } : {}),
  };
  await connection.send(input);
}

async function prompt(
  connection: ProviderConnection,
  text: string,
  clientMessageId = "m1",
  sessionId = "session-1",
): Promise<void> {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  });
}

async function waitFor<T>(
  find: () => T | undefined,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = find();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function turns(events: ProviderEvent[], state: string, sessionId = "session-1") {
  return events.filter(
    (event) => event.type === "session.turn" && event.state === state && event.sessionId === sessionId,
  );
}

function timelineItems(events: ProviderEvent[]): ProviderTimelineItem[] {
  return events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));
}

function readArgv(): string[] {
  return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
}

function readPrompts(): string[] {
  return readFileSync(promptFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as string);
}

describe("session lifecycle", () => {
  it("opens, streams an assistant message, and completes the turn", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    expect(turns(events, "started")).toHaveLength(0);
    expect(events.some((event) => event.type === "session.ready")).toBe(true);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const promptResults = events.filter(
      (event) => event.type === "session.prompt_result" && event.clientMessageId === "m1",
    );
    expect(promptResults).toHaveLength(1);
    expect(promptResults[0]).toMatchObject({ result: { type: "turn" } });

    const items = timelineItems(events);
    const userMessage = items.find((item) => item.type === "user_message");
    expect(userMessage).toMatchObject({ text: "hello", clientMessageId: "m1" });

    // The fake streams "echo:" + "hello" + "\n" as three incremental deltas, so a correct
    // accumulator ends with the whole sentence and never duplicates a prefix.
    const assistant = items.filter((item) => item.type === "assistant_message");
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.at(-1)).toMatchObject({ text: "echo:hello\n" });

    const usage = events.find((event) => event.type === "session.usage");
    expect(usage).toMatchObject({
      type: "session.usage",
      usage: { inputTokens: 15466, outputTokens: 52 },
    });

    const persistence = events.find((event) => event.type === "session.persistence");
    expect(persistence).toMatchObject({
      persistence: { version: 1, data: { conversationId: "11111111-2222-3333-4444-555555555555" } },
    });
  });

  it("launches agy in stream mode and never in print mode", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const argv = readArgv();
    for (const flag of [
      "--input-format",
      "stream-json",
      "--output-format",
      "--add-dir",
      tempDir,
      "--disable-slash-commands",
      "--print-timeout",
      "0",
      "--model",
      "gemini-3.8-flash-high",
      "--dangerously-skip-permissions",
    ]) {
      expect(argv).toContain(flag);
    }
    expect(argv).not.toContain("-p");
    expect(argv).not.toContain("--print");
    // `default` is agy's implicit mode, so it must not be passed explicitly.
    expect(argv).not.toContain("--mode");
    // Antigravity encodes the reasoning tier in the model id and rejects `--model X --effort Y`
    // with "conflicts with --effort", so the flag must never be sent.
    expect(argv).not.toContain("--effort");
  });

  it("passes the selected mode through to the CLI", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mode: "plan" });
    await prompt(connection, "plan something");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const argv = readArgv();
    expect(argv[argv.indexOf("--mode") + 1]).toBe("plan");
  });

  it("omits the approval flag when auto-approve is turned off", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { settings: { autoApprove: false } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readArgv()).not.toContain("--dangerously-skip-permissions");
    const config = events.find((event) => event.type === "session.config");
    expect(config).toMatchObject({
      config: { settings: [expect.objectContaining({ id: "autoApprove", value: false })] },
    });
  });

  it("reports the model and mode selectors in the committed config", async () => {
    const { connection, events } = await connect();
    await openSession(connection);

    const config = events.find((event) => event.type === "session.config");
    expect(config).toMatchObject({
      config: {
        model: "gemini-3.8-flash-high",
        mode: "default",
        modes: expect.arrayContaining([expect.objectContaining({ id: "accept-edits" })]),
        thinkingOptions: [],
      },
    });
    if (config?.type === "session.config") {
      expect(config.config.models.length).toBeGreaterThan(0);
    }
  });
});

describe("prompt content", () => {
  it("prepends the system prompt to the first turn of a new conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readPrompts()[0]).toBe(
      "<system_instructions>\nBe terse.\n</system_instructions>\n\nhello",
    );
  });

  it("does not repeat the system prompt on a later turn", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });
    await prompt(connection, "first", "m1");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    await prompt(connection, "second", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    expect(readPrompts()).toEqual(["<system_instructions>\nBe terse.\n</system_instructions>\n\nfirst", "second"]);
  });

  it("never prepends the system prompt when resuming a conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const conversationId = "11111111-2222-3333-4444-555555555555";
    await connection.send({
      type: "session.open",
      requestId: "open-2",
      sessionId: "session-2",
      config: sessionConfig({ systemPrompt: "Be terse." }),
      history: "skip",
      persistence: { version: 1, data: { conversationId } },
    } as ProviderInput);

    await prompt(connection, "again", "m2", "session-2");
    await waitFor(() => turns(events, "completed", "session-2")[0], "the resumed turn");

    expect(readPrompts().at(-1)).toBe("again");
    expect(readArgv()).toContain("--conversation");
    expect(readArgv()[readArgv().indexOf("--conversation") + 1]).toBe(conversationId);
  });

  it("renders attachments as text instead of dropping them", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: {
          type: "message",
          content: [
            { type: "text", text: "review this" },
            { type: "github_pr", mimeType: "application/github-pr", number: 7, title: "Fix bug", url: "https://example.com/pr/7", body: "Details" },
          ],
        },
      },
    } as ProviderInput);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readPrompts()[0]).toBe("review this\n\n[Fix bug](https://example.com/pr/7)\n\nDetails");
  });

  it("warns that MCP servers cannot be applied", async () => {
    const { connection, events } = await connect();
    await openSession(connection, {
      mcpServers: { github: { type: "stdio", command: "gh-mcp" } },
    });

    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "mcp-unsupported",
    );
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
  });
});

describe("tool calls", () => {
  it("maps tool steps to native rows with a stable id across running and completed", async () => {
    process.env.FAKE_SCENARIO = "tool";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "list files");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      callId: calls[1]?.callId,
      name: "run_command",
      status: "running",
      detail: { type: "shell", command: "ls -la", cwd: tempDir },
    });
    expect(calls[1]).toMatchObject({
      status: "completed",
      detail: { type: "shell", command: "ls -la", output: "hello.txt" },
    });
  });
});

describe("failures", () => {
  it("fails the turn with the CLI's stderr when the process dies mid-turn", async () => {
    process.env.FAKE_SCENARIO = "fail";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "agy_exit", message: expect.stringContaining("invalid model selection") },
    });
  });

  it("fails the turn when agy reports an ERROR result", async () => {
    process.env.FAKE_SCENARIO = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "ERROR", message: expect.stringContaining("Eligibility check failed") },
    });
  });

  it("cancels the running turn on interrupt and lets the session continue", async () => {
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "count forever");
    // Wait for `init` so the CLI has actually started before it is signalled.
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    const canceled = await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
    expect(canceled).toMatchObject({ error: { message: "Interrupted" } });
    expect(events.some((event) => event.type === "request.completed" && event.requestId === "i1")).toBe(true);

    // A second prompt must start a fresh process on the same conversation.
    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "hello again", "m2");
    await waitFor(() => turns(events, "completed")[0], "the follow-up turn to complete");
    expect(readArgv()).toContain("--conversation");
  });

  it("rejects prompts for unknown sessions and duplicate opens", async () => {
    const { connection } = await connect();
    await openSession(connection);

    await expect(openSession(connection)).rejects.toThrow("Session already exists");
    await expect(prompt(connection, "hi", "m1", "missing")).rejects.toThrow("Unknown session");
  });

  it("rejects every send once the connection is closed", async () => {
    const { connection } = await connect();
    await openSession(connection);
    await connection.close();

    await expect(prompt(connection, "hi")).rejects.toThrow("connection is closed");
    await expect(
      connection.send({ type: "catalog", requestId: "c1" } as ProviderInput),
    ).rejects.toThrow("connection is closed");
  });
});

describe("session.configure", () => {
  it("applies a model change by restarting with the same conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { model: "gemini-3.7-flash-low" },
    } as ProviderInput);

    const configs = events.filter((event) => event.type === "session.config");
    expect(configs.at(-1)).toMatchObject({ config: { model: "gemini-3.7-flash-low" } });
    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "cfg-1"),
    ).toBe(true);

    await prompt(connection, "second", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.7-flash-low");
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("defers a model change instead of aborting the running turn", async () => {
    // The fake stays silent in this scenario, so the turn is still running when configure arrives.
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { model: "gemini-3.7-flash-low" },
    } as ProviderInput);

    expect(
      events.some((event) => event.type === "request.completed" && event.requestId === "cfg-1"),
    ).toBe(true);
    // Switching a selector must never kill an answer that is already in flight.
    expect(turns(events, "failed")).toHaveLength(0);
    expect(turns(events, "canceled")).toHaveLength(0);

    // Finish the turn, then confirm the change lands on the next spawn.
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");

    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "next", "m2");
    await waitFor(() => turns(events, "completed")[0], "the next turn");

    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.7-flash-low");
    expect(argv).toContain("--conversation");
  });
});

describe("history replay", () => {
  it("republishes stored rows for a resumed conversation", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );

    const replayEvents: ProviderEvent[] = [];
    const replayed = await createProvider().connect({ versions: [1], capabilities: OFFERED });
    openConnections.push(replayed);
    replayed.onEvent((event) => replayEvents.push(event));

    await replayed.send({
      type: "session.open",
      requestId: "open-2",
      sessionId: "session-2",
      config: sessionConfig(),
      history: "replay",
      persistence: {
        version: 1,
        data: { conversationId: "11111111-2222-3333-4444-555555555555" },
      },
    } as ProviderInput);

    const replayedItems = timelineItems(replayEvents);
    // The user message is published before agy starts, so this also guards the buffering path.
    expect(replayedItems.some((item) => item.type === "user_message" && item.text === "hello")).toBe(true);
    expect(replayedItems.some((item) => item.type === "assistant_message")).toBe(true);

    // Replay must arrive before the session is announced ready.
    const readyIndex = replayEvents.findIndex((event) => event.type === "session.ready");
    const firstTimelineIndex = replayEvents.findIndex((event) => event.type === "timeline.item");
    expect(firstTimelineIndex).toBeGreaterThanOrEqual(0);
    expect(firstTimelineIndex).toBeLessThan(readyIndex);
  });
});
