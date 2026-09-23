import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Files larger than this are not snapshotted: a diff is not worth holding the whole file for. */
const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Tools that show a file's content, so what they saw can be the "before" of a later edit. */
const OBSERVED_TOOLS: Readonly<Record<string, true>> = {
  view_file: true,
  read_resource: true,
};

export function isObservedTool(name: string): boolean {
  return OBSERVED_TOOLS[name] === true;
}

/** agy tools whose effect on a file can be reconstructed from the file itself. */
const SNAPSHOT_TOOLS: Readonly<Record<string, true>> = {
  replace_file_content: true,
  multi_replace_file_content: true,
  sed_file: true,
  write_to_file: true,
};

export function isSnapshotTool(name: string): boolean {
  return SNAPSHOT_TOOLS[name] === true;
}

/** The target a snapshot tool was pointed at, or null when the stream did not name one. */
export function snapshotTarget(parameters: Record<string, unknown> | undefined): string | null {
  const value = parameters?.TargetFile ?? parameters?.AbsolutePath;
  return typeof value === "string" && isAbsolute(value) ? value : null;
}

export interface FileSnapshot {
  /** False when the path held no file at all, which is how a newly created file is recognised. */
  readonly exists: boolean;
  readonly text: string;
}

/**
 * A file as it stands, for comparing what a tool call changed. Null means the file cannot be
 * compared — not a regular file, larger than the snapshot limit, binary, or not valid UTF-8 — and
 * the caller falls back to the detail the stream itself carried.
 */
export async function readSnapshot(path: string): Promise<FileSnapshot | null> {
  let bytes: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return null;
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, text: "" };
    console.error(
      `[antigravity] could not read ${path} for a diff: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  // A NUL byte or an invalid sequence is a binary file, not an edit worth diffing.
  if (bytes.includes(0)) return null;
  try {
    return { exists: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return null;
  }
}
