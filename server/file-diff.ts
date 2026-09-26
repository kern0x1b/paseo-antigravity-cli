/**
 * Working out what an edit changed by comparing the file before and after.
 */

import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { OBSERVED_LIMIT } from "./constants";
import { type FileSnapshot, readSnapshot } from "./edits";
import { publish } from "./publish";
import type { Emit, OpenToolCall, Session } from "./state";
import { snapshotDiff } from "./tools";

/**
 * Keeps the newest content the plugin was shown for a path, bounded so a long session cannot
 * accumulate whole files. A caller that already holds the content passes it rather than paying
 * for a second read.
 */
export function rememberObserved(session: Session, path: string, snapshot?: FileSnapshot): void {
  session.observed.delete(path);
  session.observed.set(path, snapshot ? Promise.resolve(snapshot) : readSnapshot(path));
  if (session.observed.size > OBSERVED_LIMIT) {
    const oldest = session.observed.keys().next().value;
    if (oldest !== undefined) session.observed.delete(oldest);
  }
}

/**
 * Republishes a completed tool row with a diff once both snapshots of its target are in hand.
 * Nothing waits on it: the row the stream justified is already on screen, and Paseo replaces a
 * row by id, so a slow read can neither delay the turn nor reorder the rows after it.
 */
export async function publishEditDiff(
  session: Session,
  emit: Emit,
  tool: OpenToolCall,
  path: string,
  before: Promise<FileSnapshot | null>,
): Promise<void> {
  try {
    const [active, current] = await Promise.all([before, readSnapshot(path)]);
    if (current === null || !current.exists) return;
    // The step's own snapshot is the "before" whenever the file still held its previous content
    // when the step arrived. When it already matches, the edit had applied before ACTIVE reached
    // the plugin, and the last content the plugin was shown is what changed.
    const observed = (await session.observed.get(path)) ?? null;
    const previous = active !== null && active.text !== current.text ? active : (observed ?? active);
    if (previous === null) return;
    if (previous.exists && previous.text === current.text) return;
    if (session.closing) return;

    // write_to_file creating a file has no earlier state to diff against, so the row shows what
    // the file now holds. Anything else is described as the edit it was.
    let detail: ProviderToolCallDetail;
    if (!previous.exists && tool.name === "write_to_file") {
      detail = { type: "write", filePath: path, content: current.text };
    } else {
      const unifiedDiff = snapshotDiff(path, previous.text, current.text, session.config.cwd);
      if (unifiedDiff === null) return;
      detail = { type: "edit", filePath: path, unifiedDiff };
    }

    publish(session, emit, { type: "tool_call", ...tool, detail, status: "completed", error: null });
    rememberObserved(session, path, current);
  } catch (error) {
    console.error(
      `[antigravity] could not diff ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
