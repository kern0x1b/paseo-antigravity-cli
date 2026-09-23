import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectMcpServers, mcpConfigPath, releaseMcpServers, sweepMcpLedger } from "./mcp";

const SERVERS = {
  fs: { type: "stdio", command: "node", args: ["-e", "1"], env: { K: "V" } },
  api: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer T" } },
} as const;

let root: string;
let cwd: string;
let configPath: string;
let ledgerPath: string;
const originalPaseoHome = process.env.PASEO_HOME;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "antigravity-mcp-"));
  cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  configPath = mcpConfigPath(cwd);
  process.env.PASEO_HOME = join(root, "paseo-home");
  ledgerPath = join(root, "paseo-home", "plugin-data", "antigravity-cli", "mcp-ledger.json");
});

afterEach(() => {
  if (originalPaseoHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = originalPaseoHome;
  rmSync(root, { recursive: true, force: true });
});

function readConfig(): { mcpServers: Record<string, unknown> } & Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: Record<string, unknown> };
}

describe("workspace MCP config", () => {
  it("writes agy's entry format for stdio and http servers", async () => {
    const result = await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });

    expect(result).toMatchObject({ status: "written", entries: ["paseo-api", "paseo-fs"] });
    // The exact shape `agy mcp add` produced in the spike: serverUrl for a URL, command/args/env
    // for a process, and `disabled` on both.
    expect(readConfig()).toEqual({
      mcpServers: {
        "paseo-api": { disabled: false, headers: { Authorization: "Bearer T" }, serverUrl: "https://example.com/mcp" },
        "paseo-fs": { args: ["-e", "1"], command: "node", disabled: false, env: { K: "V" } },
      },
    });
    // The entries carry credentials, so the file the plugin creates is not world-readable.
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toEqual({
      version: 1,
      workspaces: {
        [cwd]: { created: true, createdDir: true, entries: { "paseo-api": ["s1"], "paseo-fs": ["s1"] } },
      },
    });
  });

  it("leaves the user's own entries and root keys as they were", async () => {
    const original = `${JSON.stringify(
      { mcpServers: { github: { args: ["serve"], command: "gh-mcp", disabled: false } }, telemetry: true },
      null,
      2,
    )}\n`;
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(configPath, original, "utf8");

    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    expect(readConfig().mcpServers.github).toEqual({ args: ["serve"], command: "gh-mcp", disabled: false });
    expect(readConfig().telemetry).toBe(true);

    await releaseMcpServers("s1");
    // The user's file is theirs: only the plugin's entries leave, and the rest is unchanged.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(ledgerPath)).toBe(true);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces).toEqual({});
  });

  it("refuses to touch a config that is not valid JSON", async () => {
    mkdirSync(join(cwd, ".agents"), { recursive: true });
    writeFileSync(configPath, "{ this is not json", "utf8");

    expect(await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS })).toEqual({
      status: "invalid",
      path: configPath,
    });
    expect(readFileSync(configPath, "utf8")).toBe("{ this is not json");
    // Nothing was claimed, so a later release cannot delete a file it never wrote.
    await releaseMcpServers("s1");
    expect(existsSync(configPath)).toBe(true);
  });

  it("shares one file between two sessions and deletes it when the last one leaves", async () => {
    expect(await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS })).toMatchObject({
      status: "written",
    });
    // The second session finds the identical content: no rewrite, no repeated notice.
    expect(await injectMcpServers({ cwd, sessionId: "s2", servers: SERVERS })).toMatchObject({
      status: "unchanged",
    });

    await releaseMcpServers("s1");
    expect(Object.keys(readConfig().mcpServers).sort()).toEqual(["paseo-api", "paseo-fs"]);

    await releaseMcpServers("s2");
    expect(existsSync(configPath)).toBe(false);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces).toEqual({});
  });

  it("removes the .agents directory it created when the last session leaves", async () => {
    const agents = join(cwd, ".agents");
    expect(existsSync(agents)).toBe(false);

    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(agents)).toBe(true);

    await releaseMcpServers("s1");
    expect(existsSync(configPath)).toBe(false);
    // The file was the only thing in it, and the plugin made the directory.
    expect(existsSync(agents)).toBe(false);
  });

  it("keeps a .agents directory that was already there", async () => {
    const agents = join(cwd, ".agents");
    mkdirSync(agents, { recursive: true });

    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    await releaseMcpServers("s1");

    expect(existsSync(configPath)).toBe(false);
    // Empty, but not the plugin's to remove: the user had this directory before.
    expect(existsSync(agents)).toBe(true);
  });

  it("keeps a .agents directory the plugin created once anything else is in it", async () => {
    await injectMcpServers({ cwd, sessionId: "s1", servers: SERVERS });
    const notes = join(cwd, ".agents", "notes.md");
    writeFileSync(notes, "mine\n", "utf8");

    await releaseMcpServers("s1");

    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(notes)).toBe(true);
  });

  it("removes the entries of a session that is no longer open", async () => {
    await injectMcpServers({ cwd, sessionId: "crashed", servers: SERVERS });
    await injectMcpServers({ cwd, sessionId: "live", servers: { api: SERVERS.api } });

    await sweepMcpLedger(new Set(["live"]));

    // Only what the live session still uses survives, and it keeps owning it.
    expect(Object.keys(readConfig().mcpServers)).toEqual(["paseo-api"]);
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).workspaces[cwd].entries).toEqual({
      "paseo-api": ["live"],
    });
    await releaseMcpServers("live");
    expect(existsSync(configPath)).toBe(false);
  });
});
