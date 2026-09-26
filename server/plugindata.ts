import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Root of the files the plugin owns: transcripts, attachments, and the schema files handed to
 * `agy`. Resolved per call, never cached, so a test or a reload can repoint `PASEO_HOME`.
 */
export function pluginDataDir(...segments: readonly string[]): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "antigravity-cli", ...segments);
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
