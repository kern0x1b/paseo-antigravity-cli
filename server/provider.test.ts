import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderSessionConfig,
  ProviderSetting,
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

const originalHome = process.env.HOME;

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
    "FAKE_STDERR_LINE",
    "FAKE_RESULT_ERROR",
    "FAKE_TOOL_END",
    "FAKE_RESULT_INPUT_TOKENS",
    "FAKE_STEP_INPUT_TOKENS",
    "FAKE_EDIT_FILE",
    "FAKE_EDIT_TOOL",
    "FAKE_EDIT_AFTER",
    "FAKE_EDIT_GATE",
    "FAKE_EDIT_SKIP_WRITE",
  ]) {
    delete process.env[key];
  }
  // The approval description is read from HOME, so a test that repoints it must not leak.
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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

function turnIds(events: ProviderEvent[], state: string): string[] {
  return events.flatMap((event) =>
    event.type === "session.turn" && event.state === state ? [event.turnId] : [],
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
    ]) {
      expect(argv).toContain(flag);
    }
    // Approval follows Antigravity's own setting unless the user picks otherwise.
    expect(argv).not.toContain("--dangerously-skip-permissions");
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

  it("ignores an init event whose conversation id is empty", async () => {
    process.env.FAKE_CONVERSATION_ID = "";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // An unnamed conversation must not be persisted, nor adopted as the session's identity.
    expect(events.some((event) => event.type === "session.persistence")).toBe(false);

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );
    const transcripts = join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "transcripts",
    );
    // The empty id names this file; a stray file from another session's store is not ours.
    expect(existsSync(join(transcripts, ".jsonl"))).toBe(false);
  });
});

describe("tool approval", () => {
  function approvalSetting(events: ProviderEvent[]): ProviderSetting | undefined {
    const config = events.filter((event) => event.type === "session.config").at(-1);
    return config?.type === "session.config"
      ? config.config.settings.find((setting) => setting.id === "approvalPolicy")
      : undefined;
  }

  it("offers Antigravity's own setting as the default policy", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(approvalSetting(events)).toMatchObject({
      type: "select",
      value: "agy",
      options: [
        { label: "Use Antigravity setting", value: "agy" },
        { label: "Skip all permissions", value: "skip" },
      ],
    });
    expect(readArgv()).not.toContain("--dangerously-skip-permissions");
  });

  it("adds the skip flag on the next turn after the policy is switched", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()).not.toContain("--dangerously-skip-permissions");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-1",
      sessionId: "session-1",
      changes: { settings: { approvalPolicy: "skip" } },
    } as ProviderInput);

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    expect(readArgv()).toContain("--dangerously-skip-permissions");
    expect(approvalSetting(events)).toMatchObject({ value: "skip" });
  });

  it("treats a persisted autoApprove setting as skip", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { settings: { autoApprove: true } });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readArgv()).toContain("--dangerously-skip-permissions");
    expect(approvalSetting(events)).toMatchObject({ value: "skip" });
  });

  it("names the Antigravity toolPermission that will decide approval", async () => {
    const home = join(tempDir, "home");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ toolPermission: "request-review" }),
    );
    process.env.HOME = home;

    const { connection, events } = await connect();
    await openSession(connection);

    expect(approvalSetting(events)).toMatchObject({
      description: expect.stringContaining("request-review"),
    });
  });

  it("says unknown when Antigravity's settings cannot be read", async () => {
    const missing = join(tempDir, "empty-home");
    const invalid = join(tempDir, "invalid-home");
    mkdirSync(join(invalid, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(join(invalid, ".gemini", "antigravity-cli", "settings.json"), "{ not json");

    for (const home of [missing, invalid]) {
      mkdirSync(home, { recursive: true });
      process.env.HOME = home;
      const { connection, events } = await connect();
      await openSession(connection);

      expect(approvalSetting(events)).toMatchObject({
        description: expect.stringContaining("unknown"),
      });
    }
  });
});

describe("usage", () => {
  function lastUsage(events: ProviderEvent[]) {
    const usage = events.filter((event) => event.type === "session.usage").at(-1);
    return usage?.type === "session.usage" ? usage.usage : undefined;
  }

  it("reports the last step's input tokens as the context occupancy", async () => {
    // Captured shape: the result totals every step (31074 = 15388 + 15686) while the final step
    // reports what the model actually held in its context window.
    process.env.FAKE_RESULT_INPUT_TOKENS = "31074";
    process.env.FAKE_STEP_INPUT_TOKENS = "15686";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(lastUsage(events)).toMatchObject({
      inputTokens: 31074,
      outputTokens: 52,
      contextWindowUsedTokens: 15686,
    });
  });

  it("omits the context occupancy when no step reported usage", async () => {
    process.env.FAKE_SCENARIO = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    const usage = lastUsage(events);
    expect(usage).toMatchObject({ inputTokens: 15466 });
    expect(usage).not.toHaveProperty("contextWindowUsedTokens");
  });
});

describe("queued prompts", () => {
  it("keeps a queued prompt from truncating the running answer", async () => {
    process.env.FAKE_SCENARIO = "queued";
    const { connection, events } = await connect();
    await openSession(connection);

    await prompt(connection, "one", "m1");
    // The fake streams half of turn 1's answer and then waits for a second stdin line, so the
    // queued prompt below lands while that turn is still running.
    await waitFor(
      () => timelineItems(events).find((item) => item.type === "assistant_message"),
      "turn 1 to start streaming",
    );
    await prompt(connection, "two", "m2");

    await waitFor(
      () => (turnIds(events, "completed").length === 2 ? true : undefined),
      "both turns to complete",
    );

    const assistant = timelineItems(events).filter((item) => item.type === "assistant_message");
    const firstId = assistant[0]?.id;
    const firstRow = assistant.filter((item) => item.id === firstId);
    expect(firstRow[0]).toMatchObject({ text: "echo" });
    // Turn 1 keeps one row, and its last snapshot is the whole answer, not the pre-queue prefix.
    expect(firstRow.at(-1)).toMatchObject({ text: "echo:one\n" });

    // One row per turn, each carrying its own turn id, and one completion per turn in order.
    const startedIds = turnIds(events, "started");
    expect(startedIds).toHaveLength(2);
    expect(turnIds(events, "completed")).toEqual(startedIds);
    expect(new Set(assistant.map((item) => item.id)).size).toBe(2);

    expect(firstId).toContain(startedIds[0]);
    const secondRow = assistant.find((item) => item.id !== firstId);
    expect(secondRow?.id).toContain(startedIds[1]);
    expect(assistant.filter((item) => item.id === secondRow?.id).at(-1)).toMatchObject({
      text: "echo:two\n",
    });
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

  it("republishes a tool call left running as canceled when the turn is interrupted", async () => {
    process.env.FAKE_SCENARIO = "tool-hang";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run sleep 30");
    await waitFor(
      () => timelineItems(events).find((item) => item.type === "tool_call"),
      "the tool row to appear",
    );

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls.map((item) => item.status)).toEqual(["running", "canceled"]);
    expect(calls[1]).toMatchObject({ id: calls[0]?.id, error: null });
  });

  it("republishes a tool call left running as failed when the turn fails", async () => {
    process.env.FAKE_SCENARIO = "tool-hang";
    process.env.FAKE_TOOL_END = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run sleep 30");
    await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls.map((item) => item.status)).toEqual(["running", "failed"]);
    expect(calls[1]).toMatchObject({
      id: calls[0]?.id,
      error: {
        message: "Eligibility check failed: the service is currently unavailable.",
        code: "ERROR",
      },
    });
  });

  it("republishes a tool call left running as failed when the process dies", async () => {
    process.env.FAKE_SCENARIO = "tool-hang";
    process.env.FAKE_TOOL_END = "die";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "run sleep 30");
    await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    const calls = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(calls.map((item) => item.status)).toEqual(["running", "failed"]);
    expect(calls[1]).toMatchObject({
      id: calls[0]?.id,
      error: { message: expect.stringContaining("closed the connection"), code: "agy_exit" },
    });
  });
});

describe("edit diffs", () => {
  function toolRows(events: ProviderEvent[]) {
    return timelineItems(events).filter((item) => item.type === "tool_call");
  }

  /** The streamed row arrives path-only; the diff lands when both snapshots are read. */
  async function rowWithEditDiff(events: ProviderEvent[]) {
    return waitFor(() => {
      const last = toolRows(events).at(-1);
      return last?.detail.type === "edit" && last.detail.unifiedDiff !== undefined
        ? last
        : undefined;
    }, "the edit row to carry a diff");
  }

  /**
   * The fake holds its rewrite until this file exists, so the consumer has certainly read the
   * file before the tool changes it. No timing guess is involved.
   */
  async function releaseEdit(events: ProviderEvent[], gate: string, name = "replace_file_content") {
    await waitFor(
      () => toolRows(events).find((item) => item.name === name),
      `the ${name} row`,
    );
    writeFileSync(gate, "");
  }

  it("diffs a file the stream only named", async () => {
    process.env.FAKE_SCENARIO = "edit";
    const file = join(tempDir, "hello.txt");
    writeFileSync(file, "hello world\n");
    const gate = join(tempDir, "gate");
    process.env.FAKE_EDIT_FILE = file;
    process.env.FAKE_EDIT_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "change hello to bye");
    await releaseEdit(events, gate);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const diff = (await rowWithEditDiff(events)).detail;
    expect(diff).toMatchObject({
      type: "edit",
      filePath: file,
      unifiedDiff: [
        "--- a/hello.txt",
        "+++ b/hello.txt",
        "@@ -1,1 +1,1 @@",
        "-hello world",
        "+bye world",
      ].join("\n"),
    });

    // The diff republishes the same row rather than adding one: Paseo replaces a row by id.
    const calls = toolRows(events);
    expect(calls.map((item) => item.status)).toEqual(["running", "completed", "completed"]);
    expect(new Set(calls.map((item) => item.id)).size).toBe(1);
    expect(calls[2]).toMatchObject({ id: calls[0]?.id, callId: calls[0]?.callId });
  });

  it("diffs an edit against the content an earlier step showed", async () => {
    // agy applies an edit before its step is deliverable, so the file already holds the new text
    // when the step arrives; only the content a previous step showed can describe the change.
    process.env.FAKE_SCENARIO = "edit-applied";
    const file = join(tempDir, "hello.txt");
    writeFileSync(file, "hello world\n");
    const gate = join(tempDir, "gate");
    process.env.FAKE_EDIT_FILE = file;
    process.env.FAKE_EDIT_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "change hello to bye");
    await releaseEdit(events, gate, "view_file");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const diff = (await rowWithEditDiff(events)).detail;
    expect(diff).toMatchObject({ type: "edit", filePath: file });
    expect(diff.type === "edit" ? diff.unifiedDiff : "").toBe(
      ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,1 +1,1 @@", "-hello world", "+bye world"].join(
        "\n",
      ),
    );
  });

  it("publishes the content of a file that write_to_file creates", async () => {
    process.env.FAKE_SCENARIO = "edit";
    process.env.FAKE_EDIT_TOOL = "write_to_file";
    process.env.FAKE_EDIT_AFTER = "alpha\n";
    const file = join(tempDir, "notes.txt");
    const gate = join(tempDir, "gate");
    process.env.FAKE_EDIT_FILE = file;
    process.env.FAKE_EDIT_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "create notes.txt");
    await releaseEdit(events, gate, "write_to_file");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const row = await waitFor(() => {
      const last = toolRows(events).at(-1);
      return last?.detail.type === "write" && last.detail.content !== undefined ? last : undefined;
    }, "the write row to carry the new file's content");

    expect(row).toMatchObject({
      status: "completed",
      detail: { type: "write", filePath: file, content: "alpha\n" },
    });
  });

  it("keeps the streamed detail when the file cannot be compared", async () => {
    process.env.FAKE_SCENARIO = "edit";
    // The step reports success without touching the binary file, so neither snapshot is text and
    // no diff can ever be published, whatever the ordering.
    process.env.FAKE_EDIT_SKIP_WRITE = "1";
    const file = join(tempDir, "image.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    process.env.FAKE_EDIT_FILE = file;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "edit the image");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // A second turn is the barrier: a republish for the first would have landed by now.
    await prompt(connection, "and again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn to complete");

    const calls = toolRows(events);
    expect(calls.map((item) => item.status)).toEqual([
      "running",
      "completed",
      "running",
      "completed",
    ]);
    expect(calls[1]?.detail).toEqual({ type: "edit", filePath: file });
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

  it("quotes only the stderr of the process that served the turn", async () => {
    process.env.FAKE_SCENARIO = "fail";
    process.env.FAKE_STDERR_LINE = "error: the first process failed";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello", "m1");
    await waitFor(() => turns(events, "failed")[0], "the first turn to fail");

    process.env.FAKE_STDERR_LINE = "error: the second process failed";
    await prompt(connection, "again", "m2");
    const second = await waitFor(() => turns(events, "failed")[1], "the second turn to fail");

    expect(second).toMatchObject({
      error: { code: "agy_exit", message: expect.stringContaining("second process failed") },
    });
    expect(second).not.toMatchObject({
      error: { message: expect.stringContaining("first process failed") },
    });
  });

  it("fails a turn written to a CLI whose stdin has closed, then recovers on the next one", async () => {
    process.env.FAKE_SCENARIO = "stdin-closed";
    const { connection, events } = await connect();
    await openSession(connection);
    // The CLI closes its stdin before reporting init, so nothing will ever answer this turn.
    await prompt(connection, "stranded", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to report init",
    );

    // The next turn is written into the dead pipe, and refused instead of vanishing.
    await prompt(connection, "refused", "m2");
    const refused = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(refused).toMatchObject({
      error: { code: "agy_launch_failed", message: expect.stringContaining("EPIPE") },
    });

    // A live CLI replaces it on the same conversation: the stranded turn ends with the process it
    // belonged to, and the next turn runs on a fresh process.
    process.env.FAKE_SCENARIO = "text";
    await prompt(connection, "recovered", "m3");
    await waitFor(() => turns(events, "completed")[0], "the recovered turn to complete");

    expect(turns(events, "failed")).toHaveLength(2);
    expect(readPrompts().at(-1)).toBe("recovered");
    const argv = readArgv();
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
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
    // Neither an AGY_ERROR line nor an outage marker applies, so the status stands and no
    // retry is suggested.
    expect(turn).not.toMatchObject({ error: { diagnostic: expect.anything() } });
    expect(
      events.some((event) => event.type === "session.notice" && event.notice.id === "agy-unavailable"),
    ).toBe(false);
  });

  it("takes the code and diagnostic from a structured AGY_ERROR line", async () => {
    // agy 1.2.6+ documents this line; no stream-json capture of ours contains one, so the payload
    // is the documented shape (canonical status, short error, retryability, error id).
    process.env.FAKE_SCENARIO = "fail";
    const report = JSON.stringify({
      short_error: "model API request failed",
      status: "UNAVAILABLE",
      code: "503",
      retryable: true,
      error_id: "e-1234",
    });
    process.env.FAKE_STDERR_LINE = `AGY_ERROR: ${report}`;

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: {
        code: "UNAVAILABLE",
        message: "model API request failed",
        diagnostic: report,
      },
    });
    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "agy-unavailable",
    );
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
  });

  it("names a captured UNAVAILABLE (code 503) failure and asks for a retry", async () => {
    process.env.FAKE_SCENARIO = "error";
    // Copied from fixtures/05-unavailable.ndjson: a real outage during a turn.
    process.env.FAKE_RESULT_ERROR =
      "failed to send message: send failed; already reported to the user: Eligibility check failed: failed to get load code assist response: UNAVAILABLE (code 503): The service is currently unavailable.";

    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");

    expect(turn).toMatchObject({
      error: { code: "unavailable", message: expect.stringContaining("UNAVAILABLE (code 503)") },
    });
    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "agy-unavailable",
    );
    expect(notice).toMatchObject({
      notice: {
        severity: "warning",
        title: expect.stringContaining("temporarily unavailable"),
        description: expect.stringContaining("Retry"),
      },
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
  const CONVERSATION_ID = "11111111-2222-3333-4444-555555555555";

  /** Opens a second connection on the same conversation with `history: "replay"`. */
  async function replay(conversationId = CONVERSATION_ID): Promise<ProviderEvent[]> {
    const replayed = await createProvider().connect({ versions: [1], capabilities: OFFERED });
    openConnections.push(replayed);
    const events: ProviderEvent[] = [];
    replayed.onEvent((event) => events.push(event));
    await replayed.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: { version: 1, data: { conversationId } },
    } as ProviderInput);
    return events;
  }

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

    const replayEvents = await replay();
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

  it("flushes the last answer when the connection closes", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");

    // Closing lands inside the write debounce window, where the answer still lives in memory.
    await connection.close();

    const replayed = timelineItems(await replay());
    expect(replayed.filter((item) => item.type === "assistant_message").at(-1)).toMatchObject({
      text: "echo:hello\n",
    });
  });

  it("stores nothing for a session that is not persisted", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { persist: false });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );

    const transcripts = join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "transcripts",
    );
    expect(existsSync(transcripts) ? readdirSync(transcripts) : []).toEqual([]);
    expect(timelineItems(await replay())).toEqual([]);
  });
});
