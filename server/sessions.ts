import { homedir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { pluginDataDir } from "./plugindata";

const DEFAULT_LIMIT = 50;

/**
 * Only the columns Paseo needs, newest first. `parent_conversation_id` is filtered out rather than
 * selected: those rows are the runs Antigravity created for its own subagents, not conversations
 * a user can open.
 */
const SELECT_CONVERSATIONS = `select conversation_id, title, preview, last_modified_time, workspace_uris
from conversation_summaries
where parent_conversation_id = ''
order by last_modified_time desc`;

interface ConversationRow {
  conversation_id: string;
  title: string;
  preview: string;
  last_modified_time: string;
  workspace_uris: string;
}

export interface ConversationQuery {
  cwd?: string;
  query?: string;
  limit?: number;
  /**
   * Conversations to leave out. Applied before the limit, so a limit of N still finds N
   * conversations when the newest ones are excluded.
   */
  exclude?: (conversationId: string) => boolean;
}

/**
 * Reads Antigravity's own conversation index so an existing conversation can be opened in Paseo.
 * The database is only ever read (the CLI owns it), and every failure - missing file, unexpected
 * schema, locked or corrupt pages - yields an empty list plus a log line, never a thrown error.
 */
export function listConversations(options: ConversationQuery): ProviderSessionSummary[] {
  const rows = readConversations();
  const wantedCwd = options.cwd === undefined ? undefined : stripTrailingSlash(options.cwd);
  const wantedText = options.query?.trim().toLowerCase();
  const requested = options.limit ?? DEFAULT_LIMIT;
  const limit = requested > 0 ? Math.floor(requested) : DEFAULT_LIMIT;

  const summaries: ProviderSessionSummary[] = [];
  for (const row of rows) {
    if (options.exclude?.(row.conversation_id)) continue;
    const workspace = firstWorkspacePath(row.workspace_uris);
    if (
      wantedCwd !== undefined &&
      (workspace === null || stripTrailingSlash(workspace) !== wantedCwd)
    ) {
      continue;
    }
    if (
      wantedText !== undefined &&
      wantedText.length > 0 &&
      !`${row.title}\n${row.preview}`.toLowerCase().includes(wantedText)
    ) {
      continue;
    }
    const title = row.title.trim();
    const preview = row.preview.trim();
    const updatedAt = isoTimestamp(row.last_modified_time);
    summaries.push({
      persistence: { version: 1, data: { conversationId: row.conversation_id } },
      cwd: workspace ?? options.cwd ?? "",
      ...(title.length > 0 ? { title } : {}),
      ...(preview.length > 0 ? { description: preview } : {}),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
}

function readConversations(): ConversationRow[] {
  const path = join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare(SELECT_CONVERSATIONS).all().map(toRow);
  } catch (error) {
    console.error(`[antigravity] could not read Antigravity conversations: ${describe(error)}`);
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // A database that never opened has nothing to close.
    }
  }
}

function toRow(value: Record<string, unknown>): ConversationRow {
  const text = (key: string): string => (typeof value[key] === "string" ? value[key] : "");
  return {
    conversation_id: text("conversation_id"),
    title: text("title"),
    preview: text("preview"),
    last_modified_time: text("last_modified_time"),
    workspace_uris: text("workspace_uris"),
  };
}

/**
 * `workspace_uris` holds a JSON array of `file://` URIs, and is empty for a conversation with no
 * workspace. A malformed value is treated the same as an empty one. agy records every `--add-dir`
 * the plugin passed, sorted, so the plugin's own folders (attachments, skills) can come before the
 * workspace; they are never the conversation's workspace and are skipped.
 */
function firstWorkspacePath(workspaceUris: string): string | null {
  if (workspaceUris.trim().length === 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(workspaceUris);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded)) return null;
  const own = stripTrailingSlash(pluginDataDir());
  for (const uri of decoded) {
    if (typeof uri !== "string") continue;
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      continue;
    }
    const bare = stripTrailingSlash(path);
    if (bare === own || bare.startsWith(`${own}${sep}`)) continue;
    return path;
  }
  return null;
}

/** Antigravity stores `2026-09-23 13:31:32.28859+00:00`; Paseo expects an ISO timestamp. */
function isoTimestamp(timestamp: string): string | undefined {
  const parsed = new Date(timestamp.trim().replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
