import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { pluginDataDir, unsafePathChars } from "./plugindata";

/**
 * Remembers the timeline rows a conversation produced so `session.open` with `history: "replay"`
 * can publish them again after a daemon restart or an agent import.
 *
 * Items are keyed by id because streaming updates republish the same row with more text; keeping
 * only the newest snapshot per id is what makes replay match the live view.
 */
const MAX_ITEMS = 500;
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
          const item = JSON.parse(trimmed) as ProviderTimelineItem;
          if (item && typeof item === "object" && typeof item.id === "string") {
            store.items.set(item.id, item);
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
    const body = this.list()
      .map((item) => JSON.stringify(item))
      .join("\n");
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body.length > 0 ? `${body}\n` : "", "utf8");
    } catch (error) {
      console.error(`[antigravity] could not persist transcript: ${describe(error)}`);
    }
  }
}

function transcriptPath(conversationId: string): string {
  return pluginDataDir("transcripts", `${conversationId.replace(unsafePathChars, "_")}.jsonl`);
}

/** Whether this plugin ever stored a timeline for the conversation. */
export function transcriptExists(conversationId: string): boolean {
  return existsSync(transcriptPath(conversationId));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
