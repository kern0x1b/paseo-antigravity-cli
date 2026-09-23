import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderConnection,
  ProviderContent,
  ProviderEvent,
  ProviderInput,
  ProviderPersistence,
  ProviderSessionConfig,
  ProviderSetting,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "./provider";
import { writeConversationDb } from "./testing/conversation-db";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));
const OFFERED = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.output_schema",
  "prompt.steer",
  "session.configure",
  "session.list",
  "session.persistence",
  "permission.tool_policy",
];

const originalHome = process.env.HOME;

let tempDir: string;
let argvFile: string;
let argvLog: string;
let promptFile: string;
let openConnections: ProviderConnection[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-provider-"));
  argvFile = join(tempDir, "argv.json");
  argvLog = join(tempDir, "argv-log.jsonl");
  promptFile = join(tempDir, "prompts.jsonl");

  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  process.env.PASEO_HOME = join(tempDir, "paseo-home");
  process.env.FAKE_ARGV_FILE = argvFile;
  process.env.FAKE_ARGV_LOG = argvLog;
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
    "FAKE_ARGV_LOG",
    "FAKE_PROMPT_FILE",
    "FAKE_SCENARIO",
    "FAKE_MODELS_OK",
    "FAKE_CONVERSATION_ID",
    "FAKE_STDERR_LINE",
    "FAKE_RESULT_ERROR",
    "FAKE_TOOL_END",
    "FAKE_RESULT_INPUT_TOKENS",
    "FAKE_STEP_INPUT_TOKENS",
    "FAKE_SCHEMA_OUTPUT",
    "FAKE_SCHEMA_ERROR",
    "FAKE_SCHEMA_GATE",
    "FAKE_SCHEMA_STICKY",
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

async function promptContent(
  connection: ProviderConnection,
  content: ProviderContent[],
  clientMessageId = "m1",
  outputSchema?: unknown,
  sessionId = "session-1",
): Promise<void> {
  await connection.send({
    type: "session.prompt",
    sessionId,
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content },
      ...(outputSchema === undefined ? {} : { outputSchema }),
    },
  } as ProviderInput);
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

/**
 * What Paseo itself would compute from these events. Its plugin-provider maps every assistant
 * snapshot to a *delta* appended to the message the id belongs to
 * (`text.startsWith(previous) ? text.slice(previous.length) : text`), so a republished row that is
 * not a prefix extension appends a second answer instead of replacing the first, and a turn's
 * answer is the concatenation of its contiguous trailing assistant messages.
 */
function paseoView(events: ProviderEvent[]): { messages: Map<string, string>; finalText: string } {
  const messages = new Map<string, string>();
  let trailing: string[] = [];
  for (const item of timelineItems(events)) {
    if (item.type !== "assistant_message") {
      trailing = [];
      continue;
    }
    const previous = messages.get(item.id) ?? "";
    const delta = item.text.startsWith(previous) ? item.text.slice(previous.length) : item.text;
    messages.set(item.id, previous + delta);
    if (!trailing.includes(item.id)) trailing.push(item.id);
  }
  return { messages, finalText: trailing.map((id) => messages.get(id) ?? "").join("") };
}

function readArgv(): string[] {
  return JSON.parse(readFileSync(argvFile, "utf8")) as string[];
}

/** The flags of every launch this test made, oldest first. */
function readArgvLog(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function readPrompts(): string[] {
  if (!existsSync(promptFile)) return [];
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
    // accumulator ends with the whole sentence and never duplicates a prefix. Paseo's own delta
    // mapping over the published snapshots must agree.
    const assistant = items.filter((item) => item.type === "assistant_message");
    expect(assistant.length).toBeGreaterThan(0);
    expect(assistant.at(-1)).toMatchObject({ text: "echo:hello\n" });
    expect(paseoView(events).finalText).toBe("echo:hello\n");

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
        // A slug persisted before tiers existed still reports the tier it launches with.
        thinkingOption: "high",
        thinkingOptions: [
          { id: "high", label: "High" },
          { id: "medium", label: "Medium" },
          { id: "low", label: "Low" },
        ],
      },
    });
    if (config?.type === "session.config") {
      expect(config.config.models.length).toBeGreaterThan(0);
    }
  });

  it("reports no tier for a model that has none", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "claude-opus-4-6-thinking" });

    expect(events.find((event) => event.type === "session.config")).toMatchObject({
      config: { model: "claude-opus-4-6-thinking", thinkingOptions: [] },
    });
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

describe("thinking tiers", () => {
  it("launches the family slug with the tier the composer chose", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "gemini-3.8-flash", thinkingOption: "low" });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // The tier is part of the model id, and `--effort` is rejected alongside it.
    expect(readArgv()[readArgv().indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(readArgv()).not.toContain("--effort");
  });

  it("launches a full slug persisted before tiers existed unchanged", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "gemini-3.8-flash-high", thinkingOption: undefined });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    expect(readArgv()[readArgv().indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  });

  it("relaunches with the new tier on the next turn", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { model: "gemini-3.8-flash", thinkingOption: "high" });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()[readArgv().indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");

    await connection.send({
      type: "session.configure",
      requestId: "cfg-tier",
      sessionId: "session-1",
      changes: { thinkingOption: "low" },
    } as ProviderInput);

    expect(events.filter((event) => event.type === "session.config").at(-1)).toMatchObject({
      config: { thinkingOption: "low" },
    });

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");

    // The tier is a launch-time flag, so the CLI is replaced on the same conversation.
    const argv = readArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
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

describe("launch settings", () => {
  function setting(events: ProviderEvent[], id: string): ProviderSetting | undefined {
    const config = events.filter((event) => event.type === "session.config").at(-1);
    return config?.type === "session.config"
      ? config.config.settings.find((candidate) => candidate.id === id)
      : undefined;
  }

  it("adds --sandbox on the next turn after the select is switched", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgv()).not.toContain("--sandbox");
    expect(setting(events, "sandbox")).toMatchObject({ type: "select", value: "off" });

    await connection.send({
      type: "session.configure",
      requestId: "cfg-sandbox",
      sessionId: "session-1",
      changes: { settings: { sandbox: "on" } },
    } as ProviderInput);
    expect(setting(events, "sandbox")).toMatchObject({ type: "select", value: "on" });

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    expect(readArgv()).toContain("--sandbox");
  });

  it("offers the boolean settings as On/Off selects", async () => {
    const { connection, events } = await connect();
    await openSession(connection);

    const settings = (() => {
      const config = events.filter((event) => event.type === "session.config").at(-1);
      return config?.type === "session.config" ? config.config.settings : [];
    })();
    // Paseo renders a plugin toggle as an icon-only button with no on/off state, so a boolean
    // setting must be a select; `session.config` carries no toggle at all.
    expect(settings.some((candidate) => candidate.type === "toggle")).toBe(false);
    expect(settings.find((candidate) => candidate.id === "sandbox")).toMatchObject({
      type: "select",
      value: "off",
      options: [
        { label: "Off", value: "off" },
        { label: "On", value: "on" },
      ],
    });
    expect(settings.find((candidate) => candidate.id === "shareMcp")).toMatchObject({
      type: "select",
      value: "off",
    });
  });

  it("reads a boolean saved while the settings were toggles", async () => {
    const { connection, events } = await connect();
    await openSession(connection, {
      settings: { sandbox: true, shareMcp: true },
      mcpServers: { github: { type: "stdio", command: "gh-mcp" } },
    });

    expect(setting(events, "sandbox")).toMatchObject({ type: "select", value: "on" });
    expect(setting(events, "shareMcp")).toMatchObject({ type: "select", value: "on" });
    expect(existsSync(join(tempDir, ".agents", "mcp_config.json"))).toBe(true);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    expect(readArgv()).toContain("--sandbox");

    // The other direction: `"off"` turns the flag off again on the next launch.
    await connection.send({
      type: "session.configure",
      requestId: "cfg-off",
      sessionId: "session-1",
      changes: { settings: { sandbox: "off" } },
    } as ProviderInput);
    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    expect(setting(events, "sandbox")).toMatchObject({ value: "off" });
    expect(readArgv()).not.toContain("--sandbox");
  });

  it("opens and closes the composer's settings probe without side effects", async () => {
    // The draft composer opens a throwaway session, with empty settings, on every model, mode, and
    // tier change: it must neither launch the CLI nor write anything outside plugin-data.
    const cwd = join(tempDir, "workspace");
    mkdirSync(cwd);
    const logged: string[] = [];
    // A launch is logged synchronously by the process factory, so this catches one whether or not
    // the child would have lived long enough to report for itself.
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]): void => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { connection, events } = await connect();
      await openSession(connection, { cwd });
      await connection.send({
        type: "session.close",
        requestId: "close-probe",
        sessionId: "session-1",
      });
      await waitFor(
        () => events.find((event) => event.type === "session.closed"),
        "the probe session to close",
      );
    } finally {
      spy.mockRestore();
    }

    expect(logged.filter((line) => line.includes("spawn"))).toEqual([]);
    expect(readArgvLog()).toEqual([]);
    const outside: string[] = [];
    const walk = (from: string): void => {
      for (const entry of readdirSync(from, { withFileTypes: true })) {
        const path = join(from, entry.name);
        if (entry.isDirectory()) walk(path);
        else outside.push(path);
      }
    };
    walk(tempDir);
    const dataDir = join(process.env.PASEO_HOME ?? "", "plugin-data");
    expect(outside.filter((path) => !path.startsWith(dataDir))).toEqual([]);
  });

  it("passes the extra directories that exist and drops the rest with a warning", async () => {
    const extra = join(tempDir, "extra");
    const file = join(tempDir, "notes.txt");
    mkdirSync(extra);
    writeFileSync(file, "not a directory");
    const missing = join(tempDir, "missing");

    const { connection, events } = await connect();
    await openSession(connection, {
      providerOptions: { addDirs: [extra, "relative/dir", missing, file] },
    });
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    // One --add-dir per accepted path, after the workspace and the attachments folder.
    const argv = readArgv();
    expect(argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1]] : []))).toEqual([
      tempDir,
      expect.stringContaining("attachments"),
      extra,
    ]);
    for (const rejected of ["relative/dir", missing, file]) {
      expect(argv).not.toContain(rejected);
    }

    const notice = events.find(
      (event) => event.type === "session.notice" && event.notice.id === "add-dirs-dropped",
    );
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
    if (notice?.type === "session.notice") {
      for (const rejected of ["relative/dir", missing, file]) {
        expect(notice.notice.description).toContain(rejected);
      }
    }
  });
});

describe("Paseo MCP sharing", () => {
  const SERVERS = {
    paseo: {
      type: "stdio",
      command: "paseo-mcp",
      args: ["serve"],
      env: { PASEO_TOKEN: "secret" },
    },
  } satisfies ProviderSessionConfig["mcpServers"];
  const configPath = () => join(tempDir, ".agents", "mcp_config.json");
  const ledgerPath = () => join(tempDir, "paseo-home", "plugin-data", "antigravity-cli", "mcp-ledger.json");
  const readConfig = () =>
    JSON.parse(readFileSync(configPath(), "utf8")) as { mcpServers: Record<string, unknown> };
  const notices = (events: ProviderEvent[], id: string) =>
    events.filter((event) => event.type === "session.notice" && event.notice.id === id);

  it("writes Paseo's servers into the workspace config before the CLI starts", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });

    // The CLI reads the file at startup, so it has to be there before anything is launched.
    expect(readArgvLog()).toEqual([]);
    expect(readConfig().mcpServers).toEqual({
      "paseo-paseo": {
        args: ["serve"],
        command: "paseo-mcp",
        disabled: false,
        env: { PASEO_TOKEN: "secret" },
      },
    });
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);

    const notice = notices(events, "mcp-shared")[0];
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
    if (notice?.type === "session.notice") {
      // The file holds credentials and is inside the user's repository.
      expect(notice.notice.description).toContain(configPath());
      expect(notice.notice.description).not.toContain("secret");
    }
    expect(notices(events, "mcp-unsupported")).toEqual([]);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    expect(readArgvLog()).toHaveLength(1);
    expect(readConfig().mcpServers).toHaveProperty("paseo-paseo");
  });

  it("adds the entries on the next turn after the select is switched on", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { mcpServers: SERVERS });
    expect(existsSync(configPath())).toBe(false);
    expect(notices(events, "mcp-unsupported")).toHaveLength(1);

    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the first turn");
    expect(readArgvLog()).toHaveLength(1);

    await connection.send({
      type: "session.configure",
      requestId: "cfg-mcp",
      sessionId: "session-1",
      changes: { settings: { shareMcp: "on" } },
    } as ProviderInput);
    expect(existsSync(configPath())).toBe(false);

    await prompt(connection, "again", "m2");
    await waitFor(() => turns(events, "completed")[1], "the second turn");
    // The CLI only reads the file at startup, so the toggle rides the same relaunch as a flag.
    expect(readArgvLog()).toHaveLength(2);
    expect(readConfig().mcpServers).toHaveProperty("paseo-paseo");
    expect(notices(events, "mcp-shared")).toHaveLength(1);
  });

  it("keeps two sessions in one workspace from removing each other's entries", async () => {
    const { connection } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } }, { sessionId: "session-2" });

    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    expect(readConfig().mcpServers).toHaveProperty("paseo-paseo");

    await connection.send({ type: "session.close", requestId: "close-2", sessionId: "session-2" });
    // The plugin created the file, so nothing is left to keep it around.
    expect(existsSync(configPath())).toBe(false);
  });

  it("releases the entries when the connection closes", async () => {
    const { connection } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });
    expect(existsSync(configPath())).toBe(true);

    await connection.close();

    expect(existsSync(configPath())).toBe(false);
  });

  it("removes the entries of a session that died without closing", async () => {
    mkdirSync(join(tempDir, ".agents"), { recursive: true });
    writeFileSync(
      configPath(),
      `${JSON.stringify(
        {
          mcpServers: {
            github: { command: "gh-mcp", disabled: false },
            "paseo-ghost": { command: "ghost", disabled: false },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    mkdirSync(join(tempDir, "paseo-home", "plugin-data", "antigravity-cli"), { recursive: true });
    writeFileSync(
      ledgerPath(),
      `${JSON.stringify(
        { version: 1, workspaces: { [tempDir]: { created: false, entries: { "paseo-ghost": ["ghost"] } } } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const { connection } = await connect();
    await openSession(connection);

    expect(readConfig().mcpServers).toEqual({ github: { command: "gh-mcp", disabled: false } });
    expect(JSON.parse(readFileSync(ledgerPath(), "utf8")).workspaces).toEqual({});
  });

  it("leaves an invalid workspace config alone and says so", async () => {
    mkdirSync(join(tempDir, ".agents"), { recursive: true });
    writeFileSync(configPath(), "{ not json", "utf8");

    const { connection, events } = await connect();
    await openSession(connection, { mcpServers: SERVERS, settings: { shareMcp: true } });

    expect(readFileSync(configPath(), "utf8")).toBe("{ not json");
    const notice = notices(events, "mcp-config-invalid")[0];
    expect(notice).toMatchObject({ notice: { severity: "warning" } });
    if (notice?.type === "session.notice") {
      expect(notice.notice.description).toContain(configPath());
    }

    // The session is still usable; only the sharing was skipped.
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
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

describe("structured output", () => {
  const SCHEMA = {
    type: "object",
    properties: { color: { type: "string" }, count: { type: "number" } },
    required: ["color", "count"],
  };

  function lastAssistant(events: ProviderEvent[]) {
    return timelineItems(events)
      .filter((item) => item.type === "assistant_message")
      .at(-1);
  }

  it("answers a schema prompt with the decoded JSON as the only assistant row Paseo sees", async () => {
    process.env.FAKE_SCENARIO = "schema";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "which color?" }], "m1", SCHEMA);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const assistant = timelineItems(events).filter((item) => item.type === "assistant_message");
    // Paseo reads the answer from the last assistant row, so that row must be the JSON alone.
    expect(lastAssistant(events)).toMatchObject({ text: '{"color":"blue","count":8}' });
    // One row, added on the result: a schema turn streams no assistant rows, and agy's response
    // (the same JSON plus toolAction/toolSummary) never reaches the timeline.
    expect(new Set(assistant.map((item) => item.id)).size).toBe(1);
    expect(assistant.some((item) => item.text.includes("toolAction"))).toBe(false);
    expect(timelineItems(events).at(-1)).toMatchObject({ type: "assistant_message" });

    // What Paseo actually builds the turn's answer from: its delta mapping must yield the decoded
    // JSON alone. agy streams that answer with toolAction/toolSummary added, so a schema turn that
    // streamed and then republished its row would end up as one message holding both texts.
    expect(paseoView(events).finalText).toBe('{"color":"blue","count":8}');

    // The CLI received the schema as a file, and it was valid JSON.
    const argv = readArgv();
    const schemaPath = argv[argv.indexOf("--json-schema") + 1];
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(SCHEMA);

    // Replay is what a reopened agent shows, and it holds the JSON alone.
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );
    const replayed = await connect();
    await replayed.connection.send({
      type: "session.open",
      requestId: "open-replay",
      sessionId: "session-replay",
      config: sessionConfig(),
      history: "replay",
      persistence: {
        version: 1,
        data: { conversationId: "11111111-2222-3333-4444-555555555555" },
      },
    } as ProviderInput);
    expect(
      timelineItems(replayed.events)
        .filter((item) => item.type === "assistant_message")
        .map((item) => item.text),
    ).toEqual(['{"color":"blue","count":8}']);
  });

  it("relaunches without the schema flag for the next plain turn", async () => {
    process.env.FAKE_SCENARIO = "schema";
    // agy keeps the schema with the conversation, so the flagless process still reports the
    // schema's last structured_output: the plain turn must answer with its own text anyway.
    process.env.FAKE_SCHEMA_STICKY = "1";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "first" }], "m1", SCHEMA);
    await waitFor(() => turns(events, "completed")[0], "the schema turn");
    await prompt(connection, "second", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn");

    // Two processes: the schema turn's, then a fresh one for the plain turn on the same
    // conversation. Antigravity keeps the history, so the answer is not lost to the restart.
    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--json-schema");
    expect(launches[1]).not.toContain("--json-schema");
    expect(launches[1]?.[launches[1].indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    // The second process is not in schema mode: its answer streams as plain text, and the
    // conversation's stale schema answer is not published in its place.
    expect(lastAssistant(events)).toMatchObject({ text: "echo:second\n" });
    expect(paseoView(events).finalText).toBe("echo:second\n");
  });

  it("refuses a schema prompt while a turn is running", async () => {
    // This scenario stays silent, so the first turn is still running when the second arrives.
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await promptContent(connection, [{ type: "text", text: "with schema" }], "m2", SCHEMA);
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "m2" &&
            event.result.type === "failed",
        ),
      "the schema prompt to be refused",
    );
    expect(refusal).toMatchObject({ result: { type: "failed", error: { code: "busy" } } });

    // Nothing reached the CLI and no second process was spawned. The first prompt is awaited
    // because its write lands asynchronously in the CLI.
    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the running turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["long task"]);
    expect(readArgvLog()).toHaveLength(1);

    // The running turn itself is untouched.
    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("refuses a plain prompt while a schema turn is running", async () => {
    process.env.FAKE_SCENARIO = "schema";
    // The gate holds the schema turn open, so the plain prompt below lands while it runs.
    const gate = join(tempDir, "schema-gate");
    process.env.FAKE_SCHEMA_GATE = gate;

    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "first" }], "m1", SCHEMA);
    await waitFor(
      () => (readArgvLog().some((argv) => argv.includes("--json-schema")) ? true : undefined),
      "the schema CLI to start",
    );

    await prompt(connection, "second", "m2");
    // A running schema process answers every turn it is given against the schema, and it cannot be
    // replaced while it still owes a turn, so the plain prompt is refused instead of queued.
    const answer = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "m2",
        ),
      "the plain prompt to be answered",
    );
    expect(answer).toMatchObject({
      result: {
        type: "failed",
        error: { code: "busy", message: expect.stringContaining("structured-output") },
      },
    });

    // Nothing reached the CLI and no second process was started.
    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the schema turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["first"]);
    expect(readArgvLog()).toHaveLength(1);

    // Releasing the schema turn lets it finish, and the session still runs plain turns.
    writeFileSync(gate, "");
    await waitFor(() => turns(events, "completed")[0], "the schema turn to complete");
    expect(lastAssistant(events)).toMatchObject({ text: '{"color":"blue","count":8}' });

    await prompt(connection, "third", "m3");
    await waitFor(() => turns(events, "completed")[1], "the plain turn");
    expect(readArgvLog()).toHaveLength(2);
    expect(readArgvLog()[1]).not.toContain("--json-schema");
    expect(lastAssistant(events)).toMatchObject({ text: "echo:third\n" });
  });

  it("publishes what a schema turn said when the turn fails", async () => {
    process.env.FAKE_SCENARIO = "schema";
    process.env.FAKE_SCHEMA_ERROR = "UNAVAILABLE (code 503): The service is currently unavailable.";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "answer" }], "m1", SCHEMA);

    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(turn).toMatchObject({ error: { code: "unavailable" } });

    // The prose the schema turn buffered is published once, before the terminal turn event, so a
    // failed structured turn still shows what was said.
    const published = timelineItems(events).filter((item) => item.type === "assistant_message");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      text: '{"color":"blue","count":8,"toolAction":"Finishing task","toolSummary":"Task completion"}\n',
    });
    const failedIndex = events.findIndex(
      (event) => event.type === "session.turn" && event.state === "failed",
    );
    const itemIndex = events.findIndex(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(itemIndex).toBeGreaterThanOrEqual(0);
    expect(itemIndex).toBeLessThan(failedIndex);
  });

  it("fails the turn when agy rejects the schema file", async () => {
    // agy 1.2.9 exits 1 with no stdout for a schema it cannot read, so the turn must come back
    // as a failure instead of waiting for a result that will never arrive.
    process.env.FAKE_SCENARIO = "schema-invalid";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "answer" }], "m1", SCHEMA);

    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(turn).toMatchObject({
      error: { code: "agy_exit", message: expect.stringContaining("invalid --json-schema") },
    });
    expect(timelineItems(events).filter((item) => item.type === "assistant_message")).toEqual([]);
  });

  it("fails a schema turn when the turn itself fails", async () => {
    process.env.FAKE_SCENARIO = "error";
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [{ type: "text", text: "answer" }], "m1", SCHEMA);

    const turn = await waitFor(() => turns(events, "failed")[0], "the turn to fail");
    expect(turn).toMatchObject({ error: { code: "ERROR" } });
    // A failed turn publishes no answer, schema or not.
    expect(timelineItems(events).filter((item) => item.type === "assistant_message")).toEqual([]);
  });
});

describe("image attachments", () => {
  /** Enough of a PNG to prove the bytes survive the base64 round trip. */
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

  function attachmentsPath(sessionId = "session-1"): string {
    return join(
      process.env.PASEO_HOME ?? "",
      "plugin-data",
      "antigravity-cli",
      "attachments",
      sessionId,
    );
  }

  it("writes attached images and points the prompt at their absolute paths", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [
      { type: "text", text: "what color is this?" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      { type: "image", data: PNG.toString("base64"), mimeType: "image/jpeg" },
    ]);
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");

    const dir = attachmentsPath();
    // agy rejects image blocks, so the model is told where the file is and reads it with view_file.
    expect(readPrompts()[0]).toBe(
      [
        "what color is this?",
        "",
        `[image attached: ${join(dir, "1.png")} — view it with view_file]`,
        "",
        `[image attached: ${join(dir, "2.jpg")} — view it with view_file]`,
      ].join("\n"),
    );
    expect(readFileSync(join(dir, "1.png"))).toEqual(PNG);
    expect(readFileSync(join(dir, "2.jpg"))).toEqual(PNG);

    // The folder is passed as a second --add-dir, right after the workspace one.
    const argv = readArgv();
    const first = argv.indexOf("--add-dir");
    expect(argv.slice(first, first + 4)).toEqual(["--add-dir", tempDir, "--add-dir", dir]);

    // Nothing is left behind once the session closes.
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );
    expect(existsSync(dir)).toBe(false);
  });

  it("fails the prompt when the attachments folder cannot be created", async () => {
    // A file where the sessions' attachments folder belongs makes every mkdir below it fail.
    const home = join(tempDir, "blocked-home");
    mkdirSync(join(home, "plugin-data", "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "plugin-data", "antigravity-cli", "attachments"), "");
    process.env.PASEO_HOME = home;

    const { connection, events } = await connect();
    await openSession(connection);
    await promptContent(connection, [
      { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
    ]);

    const refusal = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.result.type === "failed",
        ),
      "the prompt to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "attachment_failed" } },
    });
    // Nothing reached the CLI and no turn was started.
    expect(readPrompts()).toEqual([]);
    expect(turns(events, "started")).toEqual([]);
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

describe("session import", () => {
  const IMPORTED_ID = "61d5201e-47e0-405e-9cd3-2264e8b5d740";

  /** Points HOME at a temp home holding an agy-shaped conversation index. */
  function seedConversations(): void {
    const home = join(tempDir, "home");
    process.env.HOME = home;
    writeConversationDb(home, [
      {
        conversationId: IMPORTED_ID,
        title: "Replace Word In File",
        preview: "In hello.txt change the word hello to bye.",
        lastModifiedTime: "2026-09-23 15:45:49.636929+00:00",
        workspacePaths: [tempDir],
      },
      {
        conversationId: "99999999-9999-9999-9999-999999999999",
        title: "Another workspace",
        preview: "Not this one",
        lastModifiedTime: "2026-09-23 16:00:00+00:00",
        workspacePaths: [join(tempDir, "elsewhere")],
      },
    ]);
  }

  async function list(
    connection: ProviderConnection,
    events: ProviderEvent[],
  ): Promise<Extract<ProviderEvent, { type: "sessions" }>> {
    await connection.send({ type: "sessions", requestId: "list-1", cwd: tempDir } as ProviderInput);
    return waitFor(
      () => events.find((event): event is Extract<ProviderEvent, { type: "sessions" }> => event.type === "sessions"),
      "the session list",
    );
  }

  it("lists Antigravity's own conversations for the requested workspace", async () => {
    seedConversations();
    const { connection, events } = await connect();
    await openSession(connection);

    expect(await list(connection, events)).toMatchObject({
      requestId: "list-1",
      sessions: [
        {
          persistence: { version: 1, data: { conversationId: IMPORTED_ID } },
          cwd: tempDir,
          title: "Replace Word In File",
          description: "In hello.txt change the word hello to bye.",
          updatedAt: "2026-09-23T15:45:49.636Z",
        },
      ],
    });
  });

  it("resumes an imported conversation and says its history is not replayed", async () => {
    seedConversations();
    const { connection, events } = await connect();
    await openSession(connection);
    const listed = await list(connection, events);
    expect(listed.sessions).toHaveLength(1);

    await openSession(connection, {}, {
      sessionId: "imported",
      history: "replay",
      persistence: listed.sessions[0]?.persistence,
    });

    // The plugin has no timeline for this conversation, and says so once.
    const notices = events.filter(
      (event) => event.type === "session.notice" && event.notice.id === "history-unavailable",
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      sessionId: "imported",
      notice: { severity: "info", title: "Earlier history is not shown" },
    });
    expect(timelineItems(events)).toEqual([]);

    // The next prompt continues the imported conversation in Antigravity.
    await prompt(connection, "carry on", "m1", "imported");
    await waitFor(() => turns(events, "completed", "imported")[0], "the imported turn");
    const argv = readArgv();
    expect(argv[argv.indexOf("--conversation") + 1]).toBe(IMPORTED_ID);
  });

  it("says nothing about replay for a conversation this plugin stored itself", async () => {
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "hello");
    await waitFor(() => turns(events, "completed")[0], "the turn to complete");
    await connection.send({ type: "session.close", requestId: "close-1", sessionId: "session-1" });
    await waitFor(
      () => events.find((event) => event.type === "session.closed"),
      "the session to close",
    );

    await openSession(connection, {}, {
      sessionId: "resumed",
      history: "replay",
      persistence: {
        version: 1,
        data: { conversationId: "11111111-2222-3333-4444-555555555555" },
      },
    });

    expect(
      events.filter((event) => event.type === "session.notice" && event.notice.id === "history-unavailable"),
    ).toEqual([]);
    expect(timelineItems(events).some((item) => item.type === "assistant_message")).toBe(true);
  });
});

describe("slash commands", () => {
  /** A command prompt, as Paseo sends one for a name in the published command list. */
  async function commandPrompt(
    connection: ProviderConnection,
    name: string,
    args: string,
    clientMessageId = "c1",
  ): Promise<void> {
    await connection.send({
      type: "session.prompt",
      sessionId: "session-1",
      prompt: {
        clientMessageId,
        delivery: "auto",
        input: { type: "command", name, arguments: args },
      },
    } as ProviderInput);
  }

  function commands(events: ProviderEvent[]): Extract<ProviderEvent, { type: "session.commands" }>[] {
    return events.flatMap((event) => (event.type === "session.commands" ? [event] : []));
  }

  /**
   * A skill in `~/.agents/skills`, the shared installer's directory, which the CLI never reads:
   * only this plugin expands it. `HOME` is repointed before the session opens, because that is
   * when the list the composer picks from is filled.
   */
  function sharedSkill(name: string, body: string): { dir: string; path: string } {
    const dir = join(tempDir, "home", ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ${name}\ndescription: A shared skill\n---\n\n${body}`, "utf8");
    process.env.HOME = join(tempDir, "home");
    return { dir, path };
  }

  /** The `--add-dir` values of one launch, in argv order. */
  function addDirsOf(argv: string[]): string[] {
    return argv.flatMap((arg, index) => (arg === "--add-dir" ? [argv[index + 1] ?? ""] : []));
  }

  it("publishes the commands before the session is ready", async () => {
    // A temp HOME keeps the CLI's own plugin and built-in skills out of the expected list.
    const home = join(tempDir, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    mkdirSync(join(tempDir, ".agents", "skills", "release-notes"), { recursive: true });
    writeFileSync(
      join(tempDir, ".agents", "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Draft the release notes\n---\n\nSteps.\n",
      "utf8",
    );

    const { connection, events } = await connect();
    await openSession(connection);

    const published = commands(events);
    expect(published).toHaveLength(1);
    expect(published[0]?.commands).toEqual([
      { name: "plan", description: expect.any(String) },
      { name: "goal", description: expect.any(String) },
      { name: "grill-me", description: expect.any(String) },
      { name: "teamwork-preview", description: expect.any(String) },
      { name: "learn", description: expect.any(String) },
      { name: "schedule", description: expect.any(String) },
      { name: "release-notes", description: "Draft the release notes" },
    ]);
    // Paseo fills the draft composer's picker only from what arrived before `session.ready`.
    const ready = events.findIndex((event) => event.type === "session.ready");
    expect(events.findIndex((event) => event.type === "session.commands")).toBeLessThan(ready);
  });

  it("serves a command on a process launched for it, then relaunches for plain turns", async () => {
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "plan", "say ok");
    await waitFor(() => turns(events, "completed")[0], "the command turn to complete");

    // The command reaches the CLI as the first token of the turn, which is what expands it, and
    // the process carrying it must not disable expansion.
    expect(readPrompts()).toEqual(["/plan say ok"]);
    const [commandLaunch] = readArgvLog();
    expect(commandLaunch).not.toContain("--disable-slash-commands");

    // A plain message that starts with `/` goes out exactly as typed: Paseo only sends a command
    // input for a name it publishes, and this one would fail the turn if the CLI expanded it.
    await prompt(connection, "/skills reload", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn to complete");

    const launches = readArgvLog();
    expect(launches).toHaveLength(2);
    expect(launches[1]).toContain("--disable-slash-commands");
    expect(launches[1]?.[launches[1].indexOf("--conversation") + 1]).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(readPrompts()).toEqual(["/plan say ok", "/skills reload"]);

    // A second command reuses the expansion process rather than restarting again.
    await commandPrompt(connection, "grill-me", "say ok", "c3");
    await waitFor(() => turns(events, "completed")[2], "the second command turn to complete");
    expect(readArgvLog()).toHaveLength(3);
    expect(readArgvLog()[2]).not.toContain("--disable-slash-commands");
    expect(readPrompts()).toEqual(["/plan say ok", "/skills reload", "/grill-me say ok"]);
  });

  it("never prepends the system prompt in front of a command", async () => {
    const { connection, events } = await connect();
    await openSession(connection, { systemPrompt: "Be terse." });

    await commandPrompt(connection, "goal", "say ok");
    await waitFor(() => turns(events, "completed")[0], "the command turn to complete");
    // The preamble would push `/goal` out of the first-token position, where the CLI stops
    // expanding it, so it waits for the first message instead.
    expect(readPrompts()).toEqual(["/goal say ok"]);

    await prompt(connection, "hello", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn to complete");
    expect(readPrompts()[1]).toBe("<system_instructions>\nBe terse.\n</system_instructions>\n\nhello");
  });

  it("refuses a command while a turn is running", async () => {
    // This scenario stays silent, so the first turn is still running when the command arrives.
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await commandPrompt(connection, "plan", "say ok", "c2");
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "c2" &&
            event.result.type === "failed",
        ),
      "the command to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "busy", message: expect.stringContaining("slash") } },
    });

    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the running turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["long task"]);
    expect(readArgvLog()).toHaveLength(1);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("expands a shared-installer skill itself, without ever sending a slash name", async () => {
    const { dir } = sharedSkill("release-notes", "List the merged pull requests.");
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "release-notes", "for v1.2");
    await waitFor(() => turns(events, "completed")[0], "the skill turn to complete");

    // The skill's own instructions are the prompt, and the CLI must keep expansion off: nothing in
    // a skill body may be read as a command. The directory line is what makes its assets reachable.
    expect(readPrompts()).toEqual([
      `[Skill: release-notes]\nList the merged pull requests.\n\nSkill directory: ${dir} — resolve relative paths in these instructions against it.\n\nUser request: for v1.2`,
    ]);
    const [launch] = readArgvLog();
    expect(launch).toContain("--disable-slash-commands");
    expect(addDirsOf(launch ?? [])).toContain(dir);
    // The timeline still reads the command that was picked, which is what Paseo matches its own
    // optimistic row against — by `clientMessageId`, and by the text it showed.
    const rows = timelineItems(events).filter((item) => item.type === "user_message");
    expect(rows.at(-1)?.text).toBe("/release-notes for v1.2");
  });

  it("takes the skill directory away again for the next plain turn", async () => {
    const { dir } = sharedSkill("release-notes", "List the merged pull requests.");
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "release-notes", "for v1.2");
    await waitFor(() => turns(events, "completed")[0], "the skill turn to complete");
    await prompt(connection, "hello", "m2");
    await waitFor(() => turns(events, "completed")[1], "the plain turn to complete");

    const launches = readArgvLog();
    expect(addDirsOf(launches[0] ?? [])).toContain(dir);
    expect(addDirsOf(launches[1] ?? [])).not.toContain(dir);
    expect(launches[1]).toContain("--disable-slash-commands");
  });

  it("fails a skill that is gone by the time its command runs", async () => {
    const { path } = sharedSkill("release-notes", "List the merged pull requests.");
    const { connection, events } = await connect();
    await openSession(connection);
    rmSync(path);

    await commandPrompt(connection, "release-notes", "for v1.2");
    const failed = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "c1",
        ),
      "the skill prompt to fail",
    );
    expect(failed).toMatchObject({
      result: {
        type: "failed",
        error: { code: "skill_unavailable", message: expect.stringContaining("release-notes") },
      },
    });
    // A turn that never started launches nothing, and sends nothing.
    expect(readArgvLog()).toEqual([]);
    expect(readPrompts()).toEqual([]);
  });

  it("fails a skill too large to send", async () => {
    sharedSkill("huge-skill", "x".repeat(70 * 1024));
    const { connection, events } = await connect();
    await openSession(connection);

    await commandPrompt(connection, "huge-skill", "go");
    const failed = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "c1",
        ),
      "the oversized skill to fail",
    );
    expect(failed).toMatchObject({
      result: {
        type: "failed",
        error: { code: "skill_too_large", message: expect.stringContaining("64 KiB") },
      },
    });
    expect(readArgvLog()).toEqual([]);
  });

  it("refuses a skill while a turn is running", async () => {
    sharedSkill("release-notes", "List the merged pull requests.");
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await prompt(connection, "long task", "m1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    // The skill needs its own `--add-dir`, and the CLI cannot be replaced while it owes a turn.
    await commandPrompt(connection, "release-notes", "for v1.2", "c2");
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "c2" &&
            event.result.type === "failed",
        ),
      "the skill to be refused",
    );
    expect(refusal).toMatchObject({
      result: { type: "failed", error: { code: "busy", message: expect.stringContaining("skill's own directory") } },
    });
    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the running turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["long task"]);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("refuses a plain prompt while a skill turn is running", async () => {
    sharedSkill("release-notes", "List the merged pull requests.");
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await commandPrompt(connection, "release-notes", "for v1.2", "c1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    // The running CLI carries the skill's directory, so the next turn's launch would differ; the
    // prompt is refused rather than queued into a process that cannot be replaced yet.
    await prompt(connection, "second", "m2");
    const refusal = await waitFor(
      () =>
        events.find(
          (event) =>
            event.type === "session.prompt_result" &&
            event.clientMessageId === "m2" &&
            event.result.type === "failed",
        ),
      "the plain prompt to be refused",
    );
    expect(refusal).toMatchObject({
      result: {
        type: "failed",
        error: { code: "busy", message: expect.stringContaining("extra skill directory") },
      },
    });

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });

  it("refuses a plain prompt while a command turn is running", async () => {
    process.env.FAKE_SCENARIO = "interrupt";
    const { connection, events } = await connect();
    await openSession(connection);
    await commandPrompt(connection, "plan", "say ok", "c1");
    await waitFor(
      () => events.find((event) => event.type === "session.persistence"),
      "the CLI to start",
    );

    await prompt(connection, "second", "m2");
    // The running CLI has expansion on, so a plain message that happens to start with `/` would be
    // expanded instead of answered; the prompt is refused rather than queued into it.
    const answer = await waitFor(
      () =>
        events.find(
          (event) => event.type === "session.prompt_result" && event.clientMessageId === "m2",
        ),
      "the plain prompt to be answered",
    );
    expect(answer).toMatchObject({
      result: {
        type: "failed",
        error: { code: "busy", message: expect.stringContaining("slash command") },
      },
    });

    await waitFor(
      () => (readPrompts().length > 0 ? true : undefined),
      "the command turn's prompt to reach the CLI",
    );
    expect(readPrompts()).toEqual(["/plan say ok"]);
    expect(readArgvLog()).toHaveLength(1);

    await connection.send({ type: "session.interrupt", requestId: "i1", sessionId: "session-1" });
    await waitFor(() => turns(events, "canceled")[0], "the turn to be canceled");
  });
});

