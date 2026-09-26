import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProviderConnection,
  type ProviderEvent,
  type ProviderRegistration,
  type ProviderSessionConfig,
  negotiateProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import contribute from "../index.server";
import {
  type AccountConfig,
  DEFAULT_ACCOUNT,
  accountsFilePath,
  loadAccounts,
  parseAccounts,
} from "./accounts";
import { archivedConversations } from "./archive";
import { attachmentsDir } from "./attachments";
import { CAPABILITIES } from "./constants";
import { mcpSessionConfigPath } from "./mcp";
import { persistenceFor } from "./persistence";
import { accountPluginDataDir, pluginDataDir } from "./plugindata";
import { createProvider } from "./provider";
import {
  assertConversationAllowed,
  conversationBelongsToAccount,
  isConversationAllowed,
  listConversations,
} from "./sessions";
import { writeConversationDb } from "./testing/conversation-db";
import { transcriptPath } from "./transcript";

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
  "session.archive",
  "session.unarchive",
  "permission",
  "permission.tool_policy",
];

describe("multi-account support", () => {
  let tempDir: string;
  let defaultHome: string;
  let workHome: string;
  let paseoHome: string;
  let envLog: string;
  let openConnections: ProviderConnection[];
  let defaultAccount: AccountConfig;
  let workAccount: AccountConfig;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agy-multi-account-"));
    defaultHome = join(tempDir, "default-home");
    workHome = join(tempDir, "work-home");
    paseoHome = join(tempDir, "paseo-home");
    envLog = join(tempDir, "env-log.jsonl");

    defaultAccount = { id: "antigravity-cli", label: "Antigravity", home: null };
    workAccount = { id: "antigravity-work", label: "Antigravity Work", home: workHome };

    mkdirSync(defaultHome, { recursive: true });
    mkdirSync(workHome, { recursive: true });
    mkdirSync(paseoHome, { recursive: true });

    chmodSync(fakeAgy, 0o755);
    process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
    process.env.PASEO_HOME = paseoHome;
    process.env.FAKE_ENV_LOG = envLog;
    delete process.env.FAKE_SCENARIO;

    openConnections = [];
  });

  afterEach(async () => {
    for (const connection of openConnections) {
      await connection.close().catch(() => {});
    }
    openConnections = [];
    process.env.HOME = originalHome;
    delete process.env.PASEO_ANTIGRAVITY_BIN;
    delete process.env.PASEO_HOME;
    delete process.env.FAKE_ENV_LOG;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function testSessionConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
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

  async function openTestConnection(provider: ProviderRegistration): Promise<{
    connection: ProviderConnection;
    events: ProviderEvent[];
  }> {
    const events: ProviderEvent[] = [];
    const connection = await provider.connect({
      versions: [1],
      capabilities: negotiateProviderCapabilities(OFFERED, CAPABILITIES),
    });
    openConnections.push(connection);
    connection.onEvent((event) => events.push(event));
    return { connection, events };
  }

  function waitForEvent(
    events: ProviderEvent[],
    predicate: (e: ProviderEvent) => boolean,
    timeoutMs = 5000,
  ): Promise<ProviderEvent> {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const found = events.find(predicate);
        if (found) {
          clearInterval(interval);
          resolve(found);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for event matching predicate"));
        }
      }, 20);
    });
  }

  describe("account configuration loading", () => {
    it("returns default account when accounts.json is missing", () => {
      const accounts = loadAccounts(join(tempDir, "missing-accounts.json"));
      expect(accounts).toEqual([DEFAULT_ACCOUNT]);
      expect(accounts[0].id).toBe("antigravity-cli");
      expect(accounts[0].label).toBe("Antigravity");
      expect(accounts[0].home).toBeNull();
    });

    it("parses valid multi-account configuration", () => {
      const config = [
        { id: "antigravity-cli", label: "Antigravity Personal", home: null },
        { id: "antigravity-work", label: "Antigravity Work", home: workHome },
      ];
      const filePath = join(tempDir, "accounts.json");
      writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");

      const accounts = loadAccounts(filePath);
      expect(accounts).toHaveLength(2);
      expect(accounts[0]).toEqual({ id: "antigravity-cli", label: "Antigravity Personal", home: null });
      expect(accounts[1]).toEqual({ id: "antigravity-work", label: "Antigravity Work", home: workHome });
    });

    it("falls back to default account when accounts.json is invalid JSON", () => {
      const filePath = join(tempDir, "invalid.json");
      writeFileSync(filePath, "{ not valid json", "utf8");
      expect(loadAccounts(filePath)).toEqual([DEFAULT_ACCOUNT]);
    });

    it("sanitizes account structure, filters invalid entries, and prevents duplicates", () => {
      expect(parseAccounts("not json")).toEqual([DEFAULT_ACCOUNT]);
      expect(parseAccounts("[]")).toEqual([DEFAULT_ACCOUNT]);

      // Invalid ID is dropped
      const withInvalid = parseAccounts(
        JSON.stringify([
          { id: "bad/id", label: "Bad" },
          { id: "good-id", label: "Good" },
        ]),
      );
      expect(withInvalid).toHaveLength(1);
      expect(withInvalid[0].id).toBe("good-id");

      // Duplicate ID is ignored
      const withDuplicates = parseAccounts(
        JSON.stringify([
          { id: "acc1", label: "Acc 1" },
          { id: "acc1", label: "Acc 1 Dup" },
        ]),
      );
      expect(withDuplicates).toHaveLength(1);
      expect(withDuplicates[0].label).toBe("Acc 1");

      // Empty label defaults to ID
      const withEmptyLabel = parseAccounts(
        JSON.stringify([{ id: "acc-no-label", label: "" }]),
      );
      expect(withEmptyLabel).toHaveLength(1);
      expect(withEmptyLabel[0].label).toBe("acc-no-label");
    });
  });

  describe("provider registration and backward compatibility", () => {
    it("registers only default provider when accounts.json is absent", () => {
      const registered: ProviderRegistration[] = [];
      const fakeServer = {
        registerProvider(provider: ProviderRegistration) {
          registered.push(provider);
        },
      } as unknown as PluginServerContext;

      contribute(fakeServer);

      expect(registered).toHaveLength(1);
      expect(registered[0].id).toBe("antigravity-cli");
      expect(registered[0].label).toBe("Antigravity");
    });

    it("registers multiple providers when accounts.json defines multiple accounts", () => {
      const accountsJsonPath = accountsFilePath();
      mkdirSync(join(paseoHome, "plugin-data", "antigravity-cli"), { recursive: true });
      writeFileSync(
        accountsJsonPath,
        JSON.stringify([
          { id: "antigravity-cli", label: "Antigravity Personal", home: null },
          { id: "antigravity-work", label: "Antigravity Work", home: workHome },
        ]),
        "utf8",
      );

      const registered: ProviderRegistration[] = [];
      const fakeServer = {
        registerProvider(provider: ProviderRegistration) {
          registered.push(provider);
        },
      } as unknown as PluginServerContext;

      contribute(fakeServer);

      expect(registered).toHaveLength(2);
      expect(registered[0].id).toBe("antigravity-cli");
      expect(registered[0].label).toBe("Antigravity Personal");
      expect(registered[1].id).toBe("antigravity-work");
      expect(registered[1].label).toBe("Antigravity Work");
    });
  });

  describe("storage path scoping", () => {
    it("scopes pluginDataDir for default and secondary accounts", () => {
      expect(pluginDataDir("test.txt")).toBe(
        join(paseoHome, "plugin-data", "antigravity-cli", "test.txt"),
      );
      expect(accountPluginDataDir(defaultAccount, "test.txt")).toBe(
        join(paseoHome, "plugin-data", "antigravity-cli", "test.txt"),
      );
      expect(accountPluginDataDir(workAccount, "test.txt")).toBe(
        join(paseoHome, "plugin-data", "antigravity-work", "test.txt"),
      );
    });

    it("scopes attachments, transcripts, and MCP directories", () => {
      const defaultAttach = attachmentsDir("sess-1", defaultAccount);
      const workAttach = attachmentsDir("sess-1", workAccount);
      expect(defaultAttach).toBe(
        join(paseoHome, "plugin-data", "antigravity-cli", "attachments", "sess-1"),
      );
      expect(workAttach).toBe(
        join(paseoHome, "plugin-data", "antigravity-work", "attachments", "sess-1"),
      );

      const defaultTranscript = transcriptPath("conv-1", defaultAccount);
      const workTranscript = transcriptPath("conv-1", workAccount);
      expect(defaultTranscript).toBe(
        join(paseoHome, "plugin-data", "antigravity-cli", "transcripts", "conv-1.jsonl"),
      );
      expect(workTranscript).toBe(
        join(paseoHome, "plugin-data", "antigravity-work", "transcripts", "conv-1.jsonl"),
      );

      const defaultMcp = mcpSessionConfigPath("sess-1", defaultAccount);
      const workMcp = mcpSessionConfigPath("sess-1", workAccount);
      expect(defaultMcp).toBe(
        join(paseoHome, "plugin-data", "antigravity-cli", "mcp", "sess-1", ".agents", "mcp_config.json"),
      );
      expect(workMcp).toBe(
        join(paseoHome, "plugin-data", "antigravity-work", "mcp", "sess-1", ".agents", "mcp_config.json"),
      );
    });
  });

  describe("process environment isolation", () => {
    it("spawns agy with default HOME for default account and work HOME for work account", async () => {
      process.env.HOME = defaultHome;

      const defaultProvider = createProvider({ account: defaultAccount });
      const workProvider = createProvider({ account: workAccount });

      const { connection: defaultConn, events: defaultEvents } = await openTestConnection(defaultProvider);
      const { connection: workConn, events: workEvents } = await openTestConnection(workProvider);

      const config = testSessionConfig();

      // Open session on default provider
      await defaultConn.send({
        type: "session.open",
        requestId: "open-1",
        sessionId: "sess-default",
        config,
        history: "skip",
      });
      await waitForEvent(defaultEvents, (e) => e.type === "session.ready");

      // Prompt default session to trigger agy launch
      await defaultConn.send({
        type: "session.prompt",
        sessionId: "sess-default",
        prompt: {
          clientMessageId: "m-1",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hello default" }] },
        },
      });
      await waitForEvent(defaultEvents, (e) => e.type === "session.turn" && e.state === "completed");

      // Open session on work provider
      await workConn.send({
        type: "session.open",
        requestId: "open-2",
        sessionId: "sess-work",
        config,
        history: "skip",
      });
      await waitForEvent(workEvents, (e) => e.type === "session.ready");

      // Prompt work session to trigger agy launch
      await workConn.send({
        type: "session.prompt",
        sessionId: "sess-work",
        prompt: {
          clientMessageId: "m-2",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "hello work" }] },
        },
      });
      await waitForEvent(workEvents, (e) => e.type === "session.turn" && e.state === "completed");

      expect(existsSync(envLog)).toBe(true);
      const lines = readFileSync(envLog, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));

      expect(lines).toHaveLength(2);
      expect(lines[0].home).toBe(defaultHome);
      expect(lines[1].home).toBe(workHome);
    });
  });

  describe("conversation listing and import isolation", () => {
    beforeEach(() => {
      process.env.HOME = defaultHome;

      // Seed conversation DB in default home
      writeConversationDb(defaultHome, [
        {
          conversationId: "conv-default-1",
          title: "Default Conversation 1",
          preview: "preview 1",
          lastModifiedTime: "2026-09-26 12:00:00.00000+00:00",
          workspacePaths: [tempDir],
        },
      ]);

      // Seed conversation DB in work home
      writeConversationDb(workHome, [
        {
          conversationId: "conv-work-1",
          title: "Work Conversation 1",
          preview: "preview work 1",
          lastModifiedTime: "2026-09-26 13:00:00.00000+00:00",
          workspacePaths: [tempDir],
        },
      ]);
    });

    it("lists only conversations belonging to the requesting account", async () => {
      const defaultList = listConversations({ account: defaultAccount });
      expect(defaultList).toHaveLength(1);
      expect(defaultList[0].title).toBe("Default Conversation 1");

      const workList = listConversations({ account: workAccount });
      expect(workList).toHaveLength(1);
      expect(workList[0].title).toBe("Work Conversation 1");
    });

    it("verifies conversation ownership and cross-account restrictions", () => {
      const allAccounts = [defaultAccount, workAccount];

      expect(conversationBelongsToAccount("conv-default-1", defaultAccount)).toBe(true);
      expect(conversationBelongsToAccount("conv-default-1", workAccount)).toBe(false);

      expect(conversationBelongsToAccount("conv-work-1", workAccount)).toBe(true);
      expect(conversationBelongsToAccount("conv-work-1", defaultAccount)).toBe(false);

      expect(isConversationAllowed("conv-default-1", defaultAccount, allAccounts)).toBe(true);
      expect(isConversationAllowed("conv-default-1", workAccount, allAccounts)).toBe(false);

      expect(isConversationAllowed("conv-work-1", workAccount, allAccounts)).toBe(true);
      expect(isConversationAllowed("conv-work-1", defaultAccount, allAccounts)).toBe(false);

      expect(() => assertConversationAllowed("conv-work-1", defaultAccount, allAccounts)).toThrow(
        'belongs to account "antigravity-work"',
      );
      expect(() => assertConversationAllowed("conv-default-1", workAccount, allAccounts)).toThrow(
        'belongs to account "antigravity-cli"',
      );
    });

    it("refuses to open a conversation belonging to another account", async () => {
      const defaultProvider = createProvider({ account: defaultAccount });
      const workProvider = createProvider({ account: workAccount });

      // Save accounts.json so loadAccounts discovers both accounts
      const accountsJsonPath = accountsFilePath();
      mkdirSync(join(paseoHome, "plugin-data", "antigravity-cli"), { recursive: true });
      writeFileSync(accountsJsonPath, JSON.stringify([defaultAccount, workAccount]), "utf8");

      const { connection: defaultConn } = await openTestConnection(defaultProvider);
      const { connection: workConn } = await openTestConnection(workProvider);

      const config = testSessionConfig();

      // Default account tries to open work conversation -> must throw
      await expect(
        defaultConn.send({
          type: "session.open",
          requestId: "open-cross-1",
          sessionId: "sess-cross-1",
          config,
          persistence: persistenceFor("conv-work-1"),
          history: "skip",
        }),
      ).rejects.toThrow('belongs to account "antigravity-work"');

      // Work account tries to open default conversation -> must throw
      await expect(
        workConn.send({
          type: "session.open",
          requestId: "open-cross-2",
          sessionId: "sess-cross-2",
          config,
          persistence: persistenceFor("conv-default-1"),
          history: "skip",
        }),
      ).rejects.toThrow('belongs to account "antigravity-cli"');
    });

    it("isolates conversation archiving between accounts", async () => {
      const defaultProvider = createProvider({ account: defaultAccount });
      const workProvider = createProvider({ account: workAccount });

      const accountsJsonPath = accountsFilePath();
      mkdirSync(join(paseoHome, "plugin-data", "antigravity-cli"), { recursive: true });
      writeFileSync(accountsJsonPath, JSON.stringify([defaultAccount, workAccount]), "utf8");

      const { connection: defaultConn, events: defaultEvents } = await openTestConnection(defaultProvider);
      const { connection: workConn, events: workEvents } = await openTestConnection(workProvider);

      // Attempt cross-account archive
      await defaultConn.send({
        type: "session.archive",
        requestId: "arch-cross-1",
        persistence: persistenceFor("conv-work-1"),
      });
      const fail1 = await waitForEvent(
        defaultEvents,
        (e) => e.type === "request.failed" && e.requestId === "arch-cross-1",
      );
      expect((fail1 as { error: { code: string } }).error.code).toBe("invalid_persistence");

      await workConn.send({
        type: "session.archive",
        requestId: "arch-cross-2",
        persistence: persistenceFor("conv-default-1"),
      });
      const fail2 = await waitForEvent(
        workEvents,
        (e) => e.type === "request.failed" && e.requestId === "arch-cross-2",
      );
      expect((fail2 as { error: { code: string } }).error.code).toBe("invalid_persistence");

      // Legitimate archive on own account
      await defaultConn.send({
        type: "session.archive",
        requestId: "arch-own-1",
        persistence: persistenceFor("conv-default-1"),
      });
      const comp1 = await waitForEvent(
        defaultEvents,
        (e) => e.type === "request.completed" && e.requestId === "arch-own-1",
      );
      expect((comp1 as { requestId: string }).requestId).toBe("arch-own-1");

      const defaultArchived = await archivedConversations(defaultAccount);
      expect(defaultArchived.has("conv-default-1")).toBe(true);

      const workArchived = await archivedConversations(workAccount);
      expect(workArchived.has("conv-default-1")).toBe(false);

      // Default sessions list now excludes the archived conversation
      const remainingDefault = listConversations({
        account: defaultAccount,
        exclude: (id) => defaultArchived.has(id),
      });
      expect(remainingDefault).toHaveLength(0);

      // Work sessions list still contains conv-work-1
      const remainingWork = listConversations({
        account: workAccount,
        exclude: (id) => workArchived.has(id),
      });
      expect(remainingWork).toHaveLength(1);
      expect(remainingWork[0].title).toBe("Work Conversation 1");
    });
  });
});
