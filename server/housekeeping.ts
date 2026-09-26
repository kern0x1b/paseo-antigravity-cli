import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataDir, safePathSegment } from "./plugindata";

/**
 * Removes what sessions that will never come back left in the plugin's data directory: the
 * attachments a prompt carried, the schema file of a structured turn, and transcripts with nothing
 * in them. A session cleans up after itself when it closes; this is for the ones that could not —
 * a process that was killed, a session that was never closed — and runs when the plugin connects.
 *
 * A session's files are kept for `retentionMs` after they were last touched, because a session
 * that closed only because the plugin reloaded comes back and may still point the model at an image
 * it attached earlier. A session that is open is never touched.
 */
export async function sweepPluginData(options: {
  live: ReadonlySet<string>;
  retentionMs: number;
}): Promise<void> {
  const live = new Set([...options.live].map((id) => safePathSegment(id)));
  const oldest = Date.now() - options.retentionMs;

  for (const [folder, suffix] of [
    ["attachments", ""],
    ["schemas", ".json"],
  ] as const) {
    for (const name of await names(pluginDataDir(folder))) {
      const session = suffix === "" ? name : name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
      if (live.has(session)) continue;
      const path = join(pluginDataDir(folder), name);
      if (!(await olderThan(path, oldest))) continue;
      await remove(path);
    }
  }

  for (const name of await names(pluginDataDir("transcripts"))) {
    const path = join(pluginDataDir("transcripts"), name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.size === 0) await remove(path);
  }
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

async function olderThan(path: string, cutoff: number): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.mtimeMs < cutoff;
}

async function remove(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch((error: unknown) => {
    console.error(`[antigravity] could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  });
}
