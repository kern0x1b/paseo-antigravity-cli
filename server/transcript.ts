import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { pluginDataDir, safePathSegment } from "./plugindata";

/**
 * Remembers the timeline rows a conversation produced so `session.open` with `history: "replay"`
 * can publish them again after a daemon restart or an agent import.
 *
 * Items are keyed by id because streaming updates republish the same row with more text; keeping
 * only the newest snapshot per id is what makes replay match the live view.
 *
 * The file holds a conversation's words, so it is readable by its owner alone, and is replaced as a
 * whole rather than rewritten in place: a crash leaves the previous file, never half of a new one.
 * When more than `MAX_ITEMS` rows were produced the oldest are dropped, and the file says so in a
 * first line of its own, so a replay can tell the user that it is not the whole conversation.
 */
export const MAX_ITEMS = 500;
const WRITE_DEBOUNCE_MS = 250;

export class TranscriptStore {
  private readonly items = new Map<string, ProviderTimelineItem>();
  /**
   * Resolved once, not per write: a debounced write can outlive the test or session that created
   * it, and reading `PASEO_HOME` at write time would then file its rows under a different home.
   */
  private readonly path: string;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  /** Whether rows older than the ones held were dropped, now or in an earlier run. */
  truncated = false;

  constructor(conversationId: string) {
    this.path = transcriptPath(conversationId);
  }

  static async load(conversationId: string): Promise<TranscriptStore> {
    const store = new TranscriptStore(conversationId);
    try {
      const raw = await readFile(store.path, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          const item = JSON.parse(trimmed) as ProviderTimelineItem & { truncated?: unknown };
          if (item && typeof item === "object" && typeof item.id === "string") {
            store.items.set(item.id, item);
          } else if (item && typeof item === "object" && item.truncated === true) {
            store.truncated = true;
          }
        } catch {
          // A torn final line is expected after a hard kill; ignore it.
        }
      }
    } catch {
      // No transcript yet.
    }
    return store;
  }

  upsert(item: ProviderTimelineItem): void {
    this.items.delete(item.id);
    this.items.set(item.id, item);

    while (this.items.size > MAX_ITEMS) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.items.delete(oldest.value);
      this.truncated = true;
    }

    this.scheduleWrite();
  }

  list(): readonly ProviderTimelineItem[] {
    return [...this.items.values()];
  }

  /** Serialise pending writes so a reload cannot interleave two writes to the same file. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.writeChain = this.writeChain.then(() => this.write()).catch(() => undefined);
    await this.writeChain;
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.writeChain = this.writeChain.then(() => this.write()).catch(() => undefined);
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref?.();
  }

  private async write(): Promise<void> {
    const path = this.path;
    const lines = this.list().map((item) => JSON.stringify(item));
    if (this.truncated) lines.unshift(JSON.stringify({ truncated: true }));
    const body = lines.join("\n");
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temp, body.length > 0 ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      console.error(`[antigravity] could not persist transcript: ${describe(error)}`);
    }
  }
}

function transcriptPath(conversationId: string): string {
  return pluginDataDir("transcripts", `${safePathSegment(conversationId)}.jsonl`);
}

/** Whether this plugin ever stored a timeline for the conversation. */
export function transcriptExists(conversationId: string): boolean {
  return existsSync(transcriptPath(conversationId));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
