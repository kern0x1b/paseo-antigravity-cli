import { homedir } from "node:os";
import { join } from "node:path";

export type AccountOrId = string | { id: string } | null | undefined;

/**
 * Root of the files the plugin owns: transcripts, attachments, schemas, MCP configs.
 * Scoped by account/provider ID. When omitted or null, uses "antigravity-cli" so
 * existing paths never move.
 */
export function accountPluginDataDir(account: AccountOrId, ...segments: readonly string[]): string {
  const id = typeof account === "object" && account !== null ? account.id : account;
  const folder = id && id.trim().length > 0 ? safePathSegment(id.trim()) : "antigravity-cli";
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", folder, ...segments);
}

/**
 * Root of the files the plugin owns for the default account ("antigravity-cli").
 */
export function pluginDataDir(...segments: readonly string[]): string {
  return accountPluginDataDir(null, ...segments);
}

/** Session and conversation ids come from outside and are not guaranteed to be path-safe. */
const unsafePathChars = /[^A-Za-z0-9._-]/g;

/**
 * A single path segment made from an id that came from outside. Dots are kept, but never as `.` or
 * `..` or a run that could climb out of the folder the segment is joined to.
 */
export function safePathSegment(value: string): string {
  const segment = value.replace(unsafePathChars, "_").replace(/\.{2,}/g, "_");
  return segment === "" || segment === "." ? "_" : segment;
}
