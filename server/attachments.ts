import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataDir, safePathSegment } from "./plugindata";

/**
 * Antigravity's stream input accepts text blocks only (`stream input content block type "image"
 * is not supported (only "text")`), so an attached image is handed over as a file the model is
 * told to open with `view_file`. The folder is passed as an extra `--add-dir` on every launch and
 * deleted when the session closes; nothing is ever written into the user's workspace.
 */
export function attachmentsDir(sessionId: string): string {
  return pluginDataDir("attachments", safePathSegment(sessionId));
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The largest image a prompt may attach. A picture is a few megabytes; past this it is not one. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Writes one decoded image part and returns the absolute path the prompt must point at. The folder
 * and the file are readable by the user alone: what a person attached is theirs.
 */
export async function writeAttachment(
  sessionId: string,
  index: number,
  data: string,
  mimeType: string,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<string> {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > maxBytes) {
    throw new Error(`the image is ${bytes.length} bytes, larger than the ${maxBytes} this plugin will attach`);
  }
  const dir = attachmentsDir(sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${index}.${EXTENSIONS[mimeType] ?? "bin"}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

export async function clearAttachments(sessionId: string): Promise<void> {
  await rm(attachmentsDir(sessionId), { recursive: true, force: true });
}
