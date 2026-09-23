import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The real table, copied verbatim from the agy 1.2.9 database this plugin reads
 * (`~/.gemini/antigravity-cli/conversation_summaries.db`), so a fixture cannot pass against a
 * column set the CLI does not have.
 */
const SCHEMA = `CREATE TABLE \`conversation_summaries\` (
  \`conversation_id\` text,
  \`title\` text NOT NULL DEFAULT "",
  \`preview\` text NOT NULL DEFAULT "",
  \`step_count\` integer NOT NULL DEFAULT 0,
  \`last_modified_time\` datetime NOT NULL,
  \`workspace_uris\` text NOT NULL,
  \`status\` text NOT NULL DEFAULT "",
  \`source\` text NOT NULL DEFAULT "",
  \`project_id\` text NOT NULL DEFAULT "",
  \`agent_name\` text NOT NULL DEFAULT "",
  \`parent_conversation_id\` text NOT NULL DEFAULT "",
  \`nesting_depth\` integer NOT NULL DEFAULT 0,
  \`battle_id\` text NOT NULL DEFAULT "",
  \`winning_conversation_id\` text NOT NULL DEFAULT "",
  \`not_fully_idle\` numeric NOT NULL DEFAULT false,
  \`killed\` numeric NOT NULL DEFAULT false,
  \`last_user_input_time\` datetime NOT NULL,
  \`last_user_input_step_index\` integer NOT NULL DEFAULT -1,
  \`app_data_dir\` text NOT NULL DEFAULT "",
  raw_summary BLOB,
  group_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (\`conversation_id\`)
)`;

export interface ConversationFixture {
  conversationId: string;
  title: string;
  preview: string;
  /** Antigravity's own format: `2026-09-23 13:31:32.28859+00:00`. */
  lastModifiedTime: string;
  /** Absolute workspace paths, stored the way the CLI stores them: a JSON array of file URIs. */
  workspacePaths: readonly string[];
  parentConversationId?: string;
}

/** Writes an agy-shaped conversation index under `home`, the way the CLI would have left it. */
export function writeConversationDb(home: string, rows: readonly ConversationFixture[]): string {
  const path = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  try {
    db.exec(SCHEMA);
    const insert = db.prepare(
      `insert into conversation_summaries
        (conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time)
        values (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        row.conversationId,
        row.title,
        row.preview,
        row.lastModifiedTime,
        row.workspacePaths.length === 0
          ? ""
          : JSON.stringify(row.workspacePaths.map((path) => `file://${path}`)),
        row.parentConversationId ?? "",
        row.lastModifiedTime,
      );
    }
  } finally {
    db.close();
  }
  return path;
}
