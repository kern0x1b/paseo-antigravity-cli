import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Antigravity setting that decides how tool calls are approved (`always-proceed`,
 * `request-review`, `agent-decides`, `turbo` in agy 1.2.9). Read on each config build so the
 * composer can name the value a launch would actually use; only this preference is read, never
 * any credential. A missing, unreadable, or malformed file is not an error: the value is simply
 * unknown and Antigravity's own default applies.
 */
export function readToolPermission(): string | null {
  const path = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).toolPermission;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}
