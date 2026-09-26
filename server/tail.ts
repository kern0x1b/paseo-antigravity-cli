import { open } from "node:fs/promises";
import { parseTranscriptLine, type TranscriptEntry } from "./entries";

/**
 * Follows one of agy's transcript files as it grows, and is the only reader of them: the
 * conversation of a stream-held turn, of a detached CLI, and of every subagent go through it.
 *
 * agy appends a step per line while it runs, so a read only asks for the bytes that were added
 * since the last one. Nothing caps the size of the file (a long agent's transcript is tens of
 * megabytes), and memory does not grow with it either: a reader started `fromStep` holds only the
 * steps from there on, and skips the older ones without parsing them.
 *
 * A step can land before its predecessor and a step can be written again with a later status, so
 * the reader keeps the latest line per step index and hands the steps back sorted.
 */

/** How much of a file one read asks for. */
const CHUNK_BYTES = 1024 * 1024;
/** `{"step_index": 12,` — how agy starts every line, which is enough to skip a step unparsed. */
const STEP_PREFIX = /^\s*\{\s*"step_index"\s*:\s*(\d+)\s*,/;
/** Consecutive failed reads after which a tailer gives up and tells its owner. */
const MAX_READ_FAILURES = 5;

export interface ReadResult {
  /** Whether the file grew (or was replaced) since the last read. */
  readonly grew: boolean;
  /** Whether a step this reader holds was added or written again. */
  readonly changed: boolean;
}

export interface TranscriptReaderOptions {
  /** Steps below this are not kept. Defaults to keeping everything. */
  readonly fromStep?: number;
}

export class TranscriptReader {
  private readonly fromStep: number;
  private readonly steps = new Map<number, TranscriptEntry>();
  /** The bytes of a last line that has no newline yet. */
  private pending: Buffer = Buffer.alloc(0);
  private offset = 0;
  private malformedLines = 0;
  private inFlight: Promise<ReadResult> | null = null;

  constructor(
    readonly path: string,
    options: TranscriptReaderOptions = {},
  ) {
    this.fromStep = options.fromStep ?? 0;
  }

  /** Bytes of the file consumed so far. */
  get bytesRead(): number {
    return this.offset;
  }

  /** Complete lines that were not a step, counted instead of dropping the file over them. */
  get malformed(): number {
    return this.malformedLines;
  }

  /** The steps held, sorted by index. */
  entries(): TranscriptEntry[] {
    return [...this.steps.values()].sort((left, right) => left.stepIndex - right.stepIndex);
  }

  /**
   * Reads what was appended since the last read. A read that is under way is joined, not repeated.
   * A file that does not exist yet reads as unchanged; any other failure rejects.
   */
  read(): Promise<ReadResult> {
    if (this.inFlight) return this.inFlight;
    const run = this.readOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async readOnce(): Promise<ReadResult> {
    let handle;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { grew: false, changed: false };
      throw error;
    }
    try {
      const { size } = await handle.stat();
      // A file smaller than what was already consumed is a different file.
      const replaced = size < this.offset;
      if (replaced) this.reset();
      let changed = replaced;
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(size - this.offset, 1)));
      let grew = replaced;
      while (this.offset < size) {
        const wanted = Math.min(buffer.length, size - this.offset);
        const { bytesRead } = await handle.read(buffer, 0, wanted, this.offset);
        if (bytesRead === 0) break;
        grew = true;
        this.offset += bytesRead;
        changed = this.consume(buffer.subarray(0, bytesRead)) || changed;
      }
      return { grew, changed };
    } finally {
      await handle.close();
    }
  }

  private reset(): void {
    this.steps.clear();
    this.pending = Buffer.alloc(0);
    this.offset = 0;
    this.malformedLines = 0;
  }

  /** Takes in a chunk: every complete line in it becomes a step, the rest waits for its newline. */
  private consume(chunk: Buffer): boolean {
    const data = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    // A newline byte never occurs inside a multi-byte character, so cutting here cannot split one.
    const end = data.lastIndexOf(0x0a);
    if (end === -1) {
      this.pending = Buffer.from(data);
      return false;
    }
    this.pending = Buffer.from(data.subarray(end + 1));
    let changed = false;
    for (const line of data.subarray(0, end).toString("utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const prefix = STEP_PREFIX.exec(line);
      if (prefix?.[1] !== undefined && Number(prefix[1]) < this.fromStep) continue;
      const entry = parseTranscriptLine(line);
      if (entry === null) {
        this.malformedLines += 1;
        continue;
      }
      if (entry.stepIndex < this.fromStep) continue;
      this.steps.set(entry.stepIndex, entry);
      changed = true;
    }
    return changed;
  }
}

export interface TailHandlers {
  /** The steps the reader holds, after a read that added or changed one. */
  onChange(entries: readonly TranscriptEntry[]): void;
  /** The file cannot be read at all: the owner is told once, and nothing more is delivered. */
  onError(reason: string): void;
}

/**
 * A reader on a timer, for an owner that wants to be told when the transcript changes. Every path
 * that stops following goes through `stop`, so no timer outlives the reason it was started.
 */
export class TranscriptTailer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private current: Promise<void> | null = null;
  private failures = 0;

  constructor(
    private readonly reader: TranscriptReader,
    private readonly handlers: TailHandlers,
    private readonly pollMs: number,
  ) {}

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One last read, delivered before this resolves: for an owner about to stop following, that has
   * to see a step written a moment ago that the timer has not come around to yet.
   */
  async drain(): Promise<void> {
    if (this.stopped) return;
    await this.current;
    if (this.stopped) return;
    await this.tick();
  }

  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    // A read that is under way delivers its own change; a second one would deliver it twice.
    if (this.current) return this.current;
    const run = this.poll().finally(() => {
      this.current = null;
    });
    this.current = run;
    return run;
  }

  private async poll(): Promise<void> {
    let result: ReadResult;
    try {
      result = await this.reader.read();
    } catch (error) {
      this.failures += 1;
      if (this.failures < MAX_READ_FAILURES || this.stopped) return;
      this.stop();
      this.handlers.onError(`${this.reader.path} could not be read: ${describe(error)}`);
      return;
    }
    this.failures = 0;
    if (this.stopped || !result.changed) return;
    try {
      this.handlers.onChange(this.reader.entries());
    } catch (error) {
      // Runs from a timer, where a throw would be an uncaught exception in the plugin host.
      console.error(`[antigravity] handling ${this.reader.path} failed: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
