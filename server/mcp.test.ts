import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanUpLegacyMcpEntries,
  mcpSessionConfigPath,
  mcpSessionDir,
  removeSessionMcpConfig,
  sweepSessionMcpConfigs,
  writeSessionMcpConfig,
} from "./mcp";

const SERVERS = {
  fs: { type: "stdio", command: "node", args: ["-e", "1"], env: { K: "V" } },
  api: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer T" } },
} as const;

let root: string;
const originalPaseoHome = process.env.PASEO_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-mcp-"));
  process.env.PASEO_HOME = join(root, "paseo-home");
});

afterEach(() => {
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  rmSync(root, { recursive: true, force: true });
});

const readConfig = (sessionId: string) =>
  JSON.parse(readFileSync(mcpSessionConfigPath(sessionId), "utf8")) as { mcpServers: Record<string, unknown> };
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("a session's MCP config", () => {
  it("writes agy's entry format for stdio and http servers", async () => {
    const result = await writeSessionMcpConfig("s1", SERVERS);

    expect(result).toMatchObject({ status: "written", dir: mcpSessionDir("s1"), entries: ["paseo-api", "paseo-fs"] });
    // The exact shape `agy mcp add` produced in the spike: serverUrl for a URL, command/args/env
    // for a process, and `disabled` on both.
    expect(readConfig("s1")).toEqual({
      mcpServers: {
        "paseo-api": { disabled: false, headers: { Authorization: "Bearer T" }, serverUrl: "https://example.com/mcp" },
        "paseo-fs": { args: ["-e", "1"], command: "node", disabled: false, env: { K: "V" } },
      },
    });
  });

  it("lives in a folder of the plugin's own, as `<folder>/.agents/mcp_config.json` for agy to read", async () => {
    await writeSessionMcpConfig("s1", SERVERS);
    expect(mcpSessionConfigPath("s1")).toBe(join(mcpSessionDir("s1"), ".agents", "mcp_config.json"));
    expect(mcpSessionDir("s1").startsWith(join(root, "paseo-home", "plugin-data", "antigravity-cli"))).toBe(true);
  });

  it("is readable by nobody but the user, at every level, even when rewritten", async () => {
    await writeSessionMcpConfig("s1", SERVERS);
    expect(mode(mcpSessionConfigPath("s1"))).toBe(0o600);
    expect(mode(join(mcpSessionDir("s1"), ".agents"))).toBe(0o700);
    expect(mode(mcpSessionDir("s1"))).toBe(0o700);

    await writeSessionMcpConfig("s1", { api: SERVERS.api });
    expect(mode(mcpSessionConfigPath("s1"))).toBe(0o600);
    expect(Object.keys(readConfig("s1").mcpServers)).toEqual(["paseo-api"]);
  });

  it("gives every session a file of its own, so one never holds another's credentials", async () => {
    await writeSessionMcpConfig("a", { api: { type: "http", url: "https://example.com/mcp?caller=a", headers: { Authorization: "Bearer TOKEN-A" } } });
    await writeSessionMcpConfig("b", { api: { type: "http", url: "https://example.com/mcp?caller=b", headers: { Authorization: "Bearer TOKEN-B" } } });

    expect(mcpSessionConfigPath("a")).not.toBe(mcpSessionConfigPath("b"));
    expect(readFileSync(mcpSessionConfigPath("a"), "utf8")).not.toContain("TOKEN-B");
    expect(readFileSync(mcpSessionConfigPath("b"), "utf8")).not.toContain("TOKEN-A");
  });

  it("keeps a session id that is not a safe file name inside the plugin's folder", () => {
    const dir = mcpSessionDir("../../etc/passwd");
    expect(dir.startsWith(join(root, "paseo-home", "plugin-data", "antigravity-cli", "mcp"))).toBe(true);
    expect(dir).not.toContain("..");
  });

  it("removes the whole folder when the session releases it, and does not mind a second time", async () => {
    await writeSessionMcpConfig("s1", SERVERS);
    await removeSessionMcpConfig("s1");
    expect(existsSync(mcpSessionDir("s1"))).toBe(false);
    await expect(removeSessionMcpConfig("s1")).resolves.toBeUndefined();
  });

  it("reports a folder it cannot write instead of throwing", async () => {
    mkdirSync(join(root, "paseo-home", "plugin-data"), { recursive: true });
    // A file where the folder has to go.
    writeFileSync(join(root, "paseo-home", "plugin-data", "antigravity-cli"), "");
    const result = await writeSessionMcpConfig("s1", SERVERS);
    expect(result).toMatchObject({ status: "failed", message: expect.any(String) });
  });

  it("removes the folders of sessions that are no longer open, and only those", async () => {
    await writeSessionMcpConfig("crashed", SERVERS);
    await writeSessionMcpConfig("live", SERVERS);

    await sweepSessionMcpConfigs(new Set(["live"]));

    expect(existsSync(mcpSessionDir("crashed"))).toBe(false);
    expect(existsSync(mcpSessionConfigPath("live"))).toBe(true);
  });

  it("sweeps nothing, and does not mind, when there is no folder at all", async () => {
    await expect(sweepSessionMcpConfigs(new Set())).resolves.toBeUndefined();
  });
});

/**
 * Earlier versions wrote a session's servers into `<workspace>/.agents/mcp_config.json`, next to
 * the user's own, and added that file to the repository's `info/exclude`. What they left behind is
 * taken back once, the first time this version runs.
 */
describe("what earlier versions left in workspaces", () => {
  let workspace: string;
  let exclude: string;
  const ledgerPath = () => join(root, "paseo-home", "plugin-data", "antigravity-cli", "mcp-ledger.json");
  const configPath = () => join(workspace, ".agents", "mcp_config.json");

  beforeEach(() => {
    workspace = join(root, "workspace");
    exclude = join(root, "repo", ".git", "info", "exclude");
    mkdirSync(join(workspace, ".agents"), { recursive: true });
    mkdirSync(join(root, "repo", ".git", "info"), { recursive: true });
    mkdirSync(join(root, "paseo-home", "plugin-data", "antigravity-cli"), { recursive: true });
  });

  function legacyLedger(overrides: { created: boolean; createdDir: boolean }): void {
    writeFileSync(
      ledgerPath(),
      JSON.stringify({
        version: 1,
        workspaces: {
          [workspace]: {
            ...overrides,
            entries: { "paseo-api": ["gone"], "paseo-fs": ["gone"] },
            gitExclude: { file: exclude, pattern: "/.agents/mcp_config.json" },
          },
        },
      }),
    );
    writeFileSync(
      exclude,
      "# mine\n*.log\n# added by paseo antigravity-cli plugin: /.agents/mcp_config.json\n/.agents/mcp_config.json\n",
    );
  }

  it("takes back its entries and its exclude lines, and keeps the user's own", async () => {
    legacyLedger({ created: false, createdDir: false });
    writeFileSync(
      configPath(),
      JSON.stringify({
        theme: "dark",
        mcpServers: { mine: { command: "mine" }, "paseo-api": { serverUrl: "https://example.com" }, "paseo-fs": { command: "node" } },
      }),
    );

    await cleanUpLegacyMcpEntries();

    expect(JSON.parse(readFileSync(configPath(), "utf8"))).toEqual({
      theme: "dark",
      mcpServers: { mine: { command: "mine" } },
    });
    expect(readFileSync(exclude, "utf8")).toBe("# mine\n*.log\n");
    expect(existsSync(ledgerPath())).toBe(false);
  });

  it("deletes a file, and a folder, that the plugin created and nothing else uses", async () => {
    legacyLedger({ created: true, createdDir: true });
    writeFileSync(configPath(), JSON.stringify({ mcpServers: { "paseo-api": {}, "paseo-fs": {} } }));

    await cleanUpLegacyMcpEntries();

    expect(existsSync(join(workspace, ".agents"))).toBe(false);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it("keeps the ledger when it could not take everything back, so a later start tries again", async () => {
    legacyLedger({ created: false, createdDir: false });
    writeFileSync(configPath(), JSON.stringify({ mcpServers: { "paseo-api": {}, "paseo-fs": {} } }));
    // Nobody may write to the file: removing the entries cannot succeed.
    chmodSync(configPath(), 0o400);
    try {
      await cleanUpLegacyMcpEntries();
      expect(existsSync(ledgerPath())).toBe(true);
      expect(readFileSync(configPath(), "utf8")).toContain("paseo-api");
    } finally {
      chmodSync(configPath(), 0o600);
    }
  });

  it("does nothing when an earlier version never ran", async () => {
    await expect(cleanUpLegacyMcpEntries()).resolves.toBeUndefined();
  });
});
