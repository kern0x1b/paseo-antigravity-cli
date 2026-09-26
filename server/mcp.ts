import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { pluginDataDir, safePathSegment } from "./plugindata";

/**
 * Opt-in sharing of Paseo's MCP servers with the CLI. Antigravity reads MCP servers from
 * `<dir>/.agents/mcp_config.json` for every directory it was given (probed 2026-09-23: a workspace
 * file in a `--add-dir` directory was loaded, and the model called the tool through
 * `call_mcp_tool` with `{ServerName, ToolName}`; `agy mcp list` only lists the user's global
 * config, so a workspace file never shows up there). The global file lives at
 * `~/.gemini/config/mcp_config.json` and is never touched by this plugin.
 *
 * The entries carry the credentials Paseo's servers use (a bearer token, environment variables),
 * so they are not written where anything but one session's own CLI can read them. Each session
 * gets a folder of its own inside the plugin's data directory, readable by the user alone, and is
 * the only CLI launched with that folder as an extra `--add-dir`. Nothing is written into the
 * user's workspace, so there is no shared file for two sessions to overwrite, no repository to keep
 * it out of, and no file of the user's to leave changed; the folder goes when the session does.
 */

/** `config.mcpServers` as Paseo passes it. agy has no sse transport, so both URL kinds map alike. */
export type McpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Readonly<Record<string, string>>;
    };

/** One `mcpServers` entry in agy's own format, with the alphabetical key order it writes. */
interface AgyMcpEntry {
  args?: string[];
  command?: string;
  disabled: false;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  serverUrl?: string;
}

/** What the entries are called, so a tool in the model's list is recognisably Paseo's. */
const ENTRY_PREFIX = "paseo-";

/** The folder holding one session's MCP config, which is what the CLI is given as `--add-dir`. */
export function mcpSessionDir(sessionId: string): string {
  return pluginDataDir("mcp", safePathSegment(sessionId));
}

/** Where agy looks for a directory's own MCP servers. */
export function mcpSessionConfigPath(sessionId: string): string {
  return join(mcpSessionDir(sessionId), ".agents", "mcp_config.json");
}

/** One `mcpServers` entry as agy writes it: `disabled` is always present. */
function toAgyEntry(server: McpServerConfig): AgyMcpEntry {
  if (server.type !== "stdio") {
    return {
      disabled: false,
      ...(server.headers ? { headers: { ...server.headers } } : {}),
      serverUrl: server.url,
    };
  }
  return {
    ...(server.args && server.args.length > 0 ? { args: [...server.args] } : {}),
    command: server.command,
    disabled: false,
    ...(server.env ? { env: { ...server.env } } : {}),
  };
}

export type WriteResult =
  | { status: "written"; dir: string; path: string; entries: string[] }
  | { status: "failed"; path: string; message: string };

/**
 * Writes the session's servers to its own folder, replacing whatever an earlier write left. The
 * file appears whole or not at all, because agy reads it while it starts.
 */
export async function writeSessionMcpConfig(
  sessionId: string,
  servers: Readonly<Record<string, McpServerConfig>>,
): Promise<WriteResult> {
  const dir = mcpSessionDir(sessionId);
  const path = mcpSessionConfigPath(sessionId);
  const named: Record<string, AgyMcpEntry> = {};
  for (const [name, server] of Object.entries(servers)) named[`${ENTRY_PREFIX}${name}`] = toAgyEntry(server);
  const text = `${JSON.stringify({ mcpServers: named }, null, 2)}\n`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    const message = describe(error);
    console.error(`[antigravity] could not write ${path}: ${message}`);
    return { status: "failed", path, message };
  }
  console.log(`[antigravity] wrote ${Object.keys(named).length} MCP entr(ies) to ${path}`);
  return { status: "written", dir, path, entries: Object.keys(named).sort() };
}

/** Deletes a session's folder, credentials and all. Nothing to delete is not an error. */
export async function removeSessionMcpConfig(sessionId: string): Promise<void> {
  await rm(mcpSessionDir(sessionId), { recursive: true, force: true });
}

/**
 * Deletes the folders of sessions that are no longer open: what a process that died without
 * closing its sessions left behind, credentials included. Runs when the plugin connects and when a
 * session opens, the two moments the set of live sessions is known.
 */
export async function sweepSessionMcpConfigs(live: ReadonlySet<string>): Promise<void> {
  const root = pluginDataDir("mcp");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  const keep = new Set([...live].map((id) => safePathSegment(id)));
  for (const name of names) {
    if (keep.has(name)) continue;
    await rm(join(root, name), { recursive: true, force: true }).catch((error: unknown) => {
      console.error(`[antigravity] could not remove ${join(root, name)}: ${describe(error)}`);
    });
  }
}

/*
 * Versions before this one wrote the entries into the workspace's own `.agents/mcp_config.json`,
 * tracked them in a ledger, and added the file to the repository's `info/exclude`. The rest of
 * this file takes exactly that back, once.
 */

/** The file agy reads is the user's, so only what this plugin wrote is touched in it. */
const configFileSchema = z.record(z.string(), z.unknown());
const serverMapSchema = z.record(z.string(), z.unknown());

/** The two lines the old version appended to a repository's `info/exclude`. */
const gitExcludeSchema = z.object({
  file: z.string(),
  pattern: z.string(),
});

const ledgerSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(
    z.string(),
    z.object({
      created: z.boolean(),
      createdDir: z.boolean().default(false),
      entries: z.record(z.string(), z.array(z.string())),
      gitExclude: gitExcludeSchema.optional(),
    }),
  ),
});

type Ledger = z.infer<typeof ledgerSchema>;
type LedgerWorkspace = Ledger["workspaces"][string];
type GitExclude = z.infer<typeof gitExcludeSchema>;

/**
 * Takes back what an earlier version left in workspaces: its `paseo-*` entries, the exclude lines
 * it added, and the file or folder it created. Every workspace is handled on its own, and the
 * ledger that records them stays until nothing is left in it, so a start that could not finish
 * tries again.
 */
export async function cleanUpLegacyMcpEntries(): Promise<void> {
  const path = pluginDataDir("mcp-ledger.json");
  const raw = await readText(path);
  if (raw === null) return;
  const parsed = ledgerSchema.safeParse(safeJson(raw));
  if (!parsed.success) {
    console.error(`[antigravity] leaving an unreadable MCP ledger at ${path} alone`);
    return;
  }
  const ledger = parsed.data;
  for (const [cwd, workspace] of Object.entries(ledger.workspaces)) {
    const names = Object.keys(workspace.entries);
    const before = workspace.entries;
    workspace.entries = {};
    try {
      await removeEntries(cwd, names, ledger);
    } catch (error) {
      workspace.entries = before;
      console.error(`[antigravity] could not take the old MCP entries back from ${cwd}: ${describe(error)}`);
    }
  }
  if (Object.keys(ledger.workspaces).length === 0) {
    await rm(path, { force: true });
    return;
  }
  try {
    await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error(`[antigravity] could not update ${path}: ${describe(error)}`);
  }
}

/**
 * Deletes the named entries from a workspace's file and forgets the workspace when nothing is left
 * in it. A file that cannot be read as an object is left alone: the ledger still points at the
 * entries, so a later session there tries again rather than losing the record.
 */
async function removeEntries(cwd: string, names: readonly string[], ledger: Ledger): Promise<void> {
  const workspace: LedgerWorkspace | undefined = ledger.workspaces[cwd];
  const path = join(cwd, ".agents", "mcp_config.json");
  const current = await readConfigFile(path);
  if (current.kind === "parsed") {
    const servers = { ...(serverMapSchema.safeParse(current.root.mcpServers).data ?? {}) };
    for (const name of names) delete servers[name];
    const root = { ...current.root, mcpServers: servers };
    if (workspace?.created && Object.keys(root).every((key) => key === "mcpServers") && Object.keys(servers).length === 0) {
      await rm(path, { force: true });
    } else {
      await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    }
  }
  if (workspace && Object.keys(workspace.entries).length === 0) {
    delete ledger.workspaces[cwd];
    // Nothing of this plugin's is left here, so the exclude it added has nothing left to hide.
    if (workspace.gitExclude) await removeGitExclude(workspace.gitExclude);
    // An `.agents` directory the plugin created itself is now empty again — unless the user keeps
    // something else in it, which keeps the directory.
    if (workspace.createdDir) await removeDirectoryIfEmpty(dirname(path));
  }
}

/** Removes a directory the plugin created, and only while nothing else has landed in it. */
async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // Not empty, or already gone: either way it is not the plugin's to remove.
  }
}

/**
 * Opens a comment on a line of its own, and names the pattern it belongs to, so the plugin can
 * recognise its own lines without guessing at the rest of the file. `info/exclude` has no comment
 * syntax at the end of a line — `/.agents/mcp_config.json  # …` is one long pattern, which
 * `git check-ignore` confirms by not matching the file — so a trailing marker would silently stop
 * excluding anything.
 */
const EXCLUDE_MARKER = "# added by paseo antigravity-cli plugin";

/** Drops the marker and the pattern line under it, and leaves every other line where it is. */
async function removeGitExclude(record: GitExclude): Promise<void> {
  const raw = await readText(record.file);
  if (raw === null) return;
  const marker = `${EXCLUDE_MARKER}: ${record.pattern}`;
  const lines = raw.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== marker) {
      kept.push(lines[index] ?? "");
      continue;
    }
    // The pattern is the plugin's only while it is still the line the marker introduces.
    if (lines[index + 1]?.trim() === record.pattern) index += 1;
  }
  const text = kept.join("\n");
  if (text === raw) return;
  try {
    await writeFile(record.file, text, "utf8");
  } catch (error) {
    console.error(`[antigravity] could not remove the exclude line in ${record.file}: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ConfigFile =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "parsed"; raw: string; root: Record<string, unknown> };

async function readConfigFile(path: string): Promise<ConfigFile> {
  const raw = await readText(path);
  if (raw === null) return { kind: "missing" };
  const parsed = configFileSchema.safeParse(safeJson(raw));
  return parsed.success ? { kind: "parsed", raw, root: parsed.data } : { kind: "invalid" };
}

/** A file the plugin does not own: a failed read and unparseable JSON are both "no data". */
async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

