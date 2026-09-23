import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { encodeUserTurn, parseAgyLine, type AgyEvent } from "./protocol";

export interface AgyLaunchConfig {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  model?: string;
  mode?: string;
  conversationId?: string;
  /** Passes --dangerously-skip-permissions, so every tool runs without approval. */
  skipPermissions: boolean;
  extraArgs?: readonly string[];
  binary?: string;
}

export interface AgyProcessHandlers {
  onEvent(event: AgyEvent): void;
  onStderr(line: string): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void;
}

/**
 * The daemon is started by a GUI app and may not inherit `~/.local/bin` on its PATH, so an
 * explicit lookup is required before falling back to PATH resolution.
 */
export function resolveAgyBinary(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const fromEnv = process.env.PASEO_ANTIGRAVITY_BIN;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  const local = join(homedir(), ".local", "bin", "agy");
  if (existsSync(local)) return local;
  return "agy";
}

export function buildAgyArgs(config: AgyLaunchConfig): string[] {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--add-dir",
    config.cwd,
    "--disable-slash-commands",
    // 0 waits until the turn completes; Paseo owns cancellation instead of a wall clock.
    "--print-timeout",
    "0",
  ];
  // `--effort` is deliberately never passed: Antigravity encodes the reasoning tier in the model
  // id itself (gemini-3.8-flash-high/medium/low) and rejects the pair with
  // "--model X conflicts with --effort=Y". The tiers are offered as separate models instead.
  if (config.model) args.push("--model", config.model);
  // `default` is the implicit mode; agy only accepts accept-edits/plan.
  if (config.mode && config.mode !== "default") args.push("--mode", config.mode);
  if (config.conversationId) args.push("--conversation", config.conversationId);
  if (config.skipPermissions) args.push("--dangerously-skip-permissions");
  if (config.extraArgs) args.push(...config.extraArgs);
  return args;
}

const SIGKILL_GRACE_MS = 5_000;

/**
 * One `agy` child process speaking NDJSON on stdin/stdout. A single process serves a whole
 * Paseo session: each stdin line is one turn, and agy emits exactly one `result` per turn.
 *
 * Note that a line written while a turn is running is *queued* into a following turn, not
 * steered into the running one, so the provider never advertises steering.
 */
export class AgyProcess {
  private child: ChildProcess | null = null;
  private disposed = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };
  private processExited = false;
  private stdinClosed = false;
  private readersPending = 0;
  private reported = false;

  constructor(
    private readonly config: AgyLaunchConfig,
    private readonly handlers: AgyProcessHandlers,
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  /**
   * Whether a turn can still be written. agy closes stdin when it gives up (it exits after every
   * error result), and the pipe error may only surface on the next write, so `running` alone is not
   * enough to decide that a process is still usable.
   */
  get acceptsInput(): boolean {
    const stdin = this.child?.stdin;
    return !!stdin && stdin.writable && !this.stdinClosed && !this.processExited;
  }

  get binary(): string {
    return resolveAgyBinary(this.config.binary);
  }

  start(): void {
    if (this.disposed) throw new Error("agy process has been disposed");
    if (this.child) throw new Error("agy process is already running");

    this.processExited = false;
    this.stdinClosed = false;
    this.readersPending = 0;
    this.reported = false;
    this.exitInfo = { code: null, signal: null };

    const binary = this.binary;
    const args = buildAgyArgs(this.config);
    console.log(`[antigravity] spawn ${binary} ${args.join(" ")} (cwd ${this.config.cwd})`);

    const child = spawn(binary, args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    // Chunks do not align to line boundaries, so let readline own the framing.
    if (child.stdout) {
      const reader = createInterface({ input: child.stdout });
      reader.on("line", (line) => {
        const event = parseAgyLine(line);
        if (event) this.handlers.onEvent(event);
      });
      reader.on("close", () => this.readerClosed());
      this.readersPending += 1;
    }

    if (child.stderr) {
      const reader = createInterface({ input: child.stderr });
      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed.length > 0) this.handlers.onStderr(trimmed);
      });
      reader.on("close", () => this.readerClosed());
      this.readersPending += 1;
    }

    child.on("error", (error) => {
      this.handlers.onStderr(`failed to launch ${this.binary}: ${error.message}`);
      this.processExited = true;
      this.reportExitIfDrained();
    });

    // agy exits after an error result, so the next turn can be written into a pipe whose reader is
    // gone. Without a listener that EPIPE is an unhandled 'error' event and takes the plugin down.
    child.stdin?.on("error", (error) => {
      this.stdinClosed = true;
      this.handlers.onStderr(`agy stdin closed: ${error.message}`);
    });

    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.processExited = true;
      this.reportExitIfDrained();
    });
  }

  /**
   * Write one user turn. Rejects when the child's stdin is gone, so a turn aimed at a process that
   * already gave up fails the turn instead of disappearing into the pipe.
   */
  async writeTurn(text: string): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || !this.acceptsInput) {
      throw new Error("agy process is not running or its stdin is closed");
    }
    const written = Promise.withResolvers<void>();
    stdin.write(encodeUserTurn(text), (error) => {
      if (error) {
        this.stdinClosed = true;
        written.reject(error);
        return;
      }
      written.resolve();
    });
    await written.promise;
  }

  /** Interrupt the running turn. agy reports `result.error = "interrupted"` and exits. */
  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = this.exitPromise;

    child.kill("SIGINT");
    const timer = setTimeout(() => {
      if (this.child) this.child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);

    try {
      if (exited) await Promise.race([exited, delay(SIGKILL_GRACE_MS + 1_000)]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Terminate immediately and release streams. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    const exited = this.exitPromise;
    if (child) {
      child.stdin?.end();
      child.kill("SIGKILL");
    }
    if (exited) await Promise.race([exited, delay(SIGKILL_GRACE_MS)]);
  }

  private readerClosed(): void {
    this.readersPending -= 1;
    this.reportExitIfDrained();
  }

  /**
   * agy emits its terminal `result` and then exits, so the exit must not be reported until every
   * buffered stdout line has been delivered. Otherwise the exit path would race the result and
   * fail a turn that actually completed.
   */
  private reportExitIfDrained(): void {
    if (this.reported) return;
    if (!this.processExited || this.readersPending > 0) return;
    this.reported = true;
    this.child = null;
    const resolve = this.resolveExit;
    this.resolveExit = null;
    this.handlers.onExit(this.exitInfo);
    resolve?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
