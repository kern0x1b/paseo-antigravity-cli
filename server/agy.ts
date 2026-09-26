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
  /** Path to the JSON Schema the turn's answer must match (--json-schema). */
  outputSchemaPath?: string;
  /** Extra directory the model may read, used for the plugin's attached images. */
  attachmentDir?: string;
  /**
   * A plugin-expanded skill's own directory, so the turn can read the scripts and templates the
   * skill's instructions refer to. Set for that one turn's launch, like the schema file.
   */
  skillDir?: string;
  /**
   * The session's private folder holding `.agents/mcp_config.json`, when Paseo's MCP servers are
   * shared. agy loads a directory's own MCP servers from the directories it was given, so this is
   * how one process — and no other — is handed credentials.
   */
  mcpDir?: string;
  /** Extra directories the user allowed, each its own --add-dir. */
  addDirs?: readonly string[];
  /** Passes --sandbox, which restricts what terminal commands may reach. */
  sandbox?: boolean;
  /**
   * Omits `--disable-slash-commands`, so a turn whose text starts with `/<name>` is expanded into
   * that command. Verified 2026-09-23: without this flag a command never expands, and with it a
   * plain message that starts with `/` expands too — which is why only a command turn gets one.
   */
  allowSlashCommands?: boolean;
  extraArgs?: readonly string[];
  binary?: string;
  /** How long a process asked to stop may take before it is killed. Defaults to `TERMINATE_GRACE_MS`. */
  terminateGraceMs?: number;
  /**
   * How long the exit of a process waits for its output to end. Something the CLI started can
   * keep the pipes open after the CLI itself is gone. Defaults to `DRAIN_GRACE_MS`.
   */
  drainGraceMs?: number;
}

export interface AgyProcessHandlers {
  onEvent(event: AgyEvent): void;
  onStderr(line: string): void;
  onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void;
}

/**
 * Where `agy` is looked for besides the PATH: the daemon is started by a GUI app and may not
 * inherit the directories a shell adds, which is where the installer (`~/.local/bin`) and Homebrew
 * (`/opt/homebrew/bin` on Apple silicon, `/usr/local/bin` on Intel) put it.
 */
export function defaultBinaryDirs(): string[] {
  return [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The binary to launch: an explicit path, the environment's, the first known directory holding one, else `agy` on the PATH. */
export function resolveAgyBinary(explicit?: string, dirs: readonly string[] = defaultBinaryDirs()): string {
  if (explicit && explicit.trim().length > 0) return explicit;
  const fromEnv = process.env.PASEO_ANTIGRAVITY_BIN;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  for (const dir of dirs) {
    const candidate = join(dir, "agy");
    if (existsSync(candidate)) return candidate;
  }
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
    // Antigravity resolves what the model may read against these directories, so the plugin's own
    // attachments folder follows the workspace one; both are absolute. The user's extra
    // directories are validated before they reach here.
    ...(config.attachmentDir ? ["--add-dir", config.attachmentDir] : []),
    ...(config.skillDir ? ["--add-dir", config.skillDir] : []),
    ...(config.mcpDir ? ["--add-dir", config.mcpDir] : []),
    ...(config.addDirs ?? []).flatMap((dir) => ["--add-dir", dir]),
    // A command turn needs expansion; every other turn must keep plain text from starting with
    // `/` out of the CLI's slash parser (` /skills` and `/tasks` kill a print-mode turn outright).
    ...(config.allowSlashCommands === true ? [] : ["--disable-slash-commands"]),
    // 0 waits until the turn completes; Paseo owns cancellation instead of a wall clock.
    "--print-timeout",
    "0",
  ];
  // `--effort` is deliberately never passed: Antigravity encodes the reasoning tier in the model
  // id itself (gemini-3.8-flash-high/medium/low) and rejects the pair with
  // "--model X conflicts with --effort=Y". The caller resolves the tier the composer chose back
  // into that slug before launch (`resolveThinking`).
  if (config.model) args.push("--model", config.model);
  // `default` is the implicit mode; agy only accepts accept-edits/plan.
  if (config.mode && config.mode !== "default") args.push("--mode", config.mode);
  if (config.conversationId) args.push("--conversation", config.conversationId);
  if (config.sandbox) args.push("--sandbox");
  if (config.skipPermissions) args.push("--dangerously-skip-permissions");
  // Launch-time only: the schema applies to every turn of the process, which is why a schema turn
  // gets its own launch and the process is replaced again before the next plain turn.
  if (config.outputSchemaPath) args.push("--json-schema", config.outputSchemaPath);
  if (config.extraArgs) args.push(...config.extraArgs);
  return args;
}

/** How long an interrupted process may take to report `interrupted` before it is killed. */
const SIGKILL_GRACE_MS = 5_000;
/** How long a process asked to stop may take to flush and exit before it is killed. */
export const TERMINATE_GRACE_MS = 3_000;
/** How long the exit of a process waits for its output pipes to end. */
export const DRAIN_GRACE_MS = 2_000;

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
  private drainTimer: NodeJS.Timeout | null = null;
  private drainExpired = false;
  /** Whether the process leads a process group of its own, which is what lets its children be reached. */
  private grouped = false;

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
    this.drainExpired = false;
    this.exitInfo = { code: null, signal: null };

    const binary = this.binary;
    const args = buildAgyArgs(this.config);
    console.log(`[antigravity] spawn ${binary} ${args.join(" ")} (cwd ${this.config.cwd})`);

    // Its own process group, so stopping the CLI can stop what it started too.
    this.grouped = process.platform !== "win32";
    const child = spawn(binary, args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.grouped,
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
      // Whatever the CLI started may hold its output open long after it is gone; the exit is
      // reported once that has had `drainGraceMs` to end.
      if (!this.reported && this.readersPending > 0) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          this.drainExpired = true;
          this.reportExitIfDrained();
        }, this.config.drainGraceMs ?? DRAIN_GRACE_MS);
        this.drainTimer.unref();
      }
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
    if (!this.child) return;
    // The CLI alone gets the interrupt: it reports the turn as interrupted and shuts down what it
    // started itself. Only a CLI that does not answer is killed with everything it started.
    this.child.kill("SIGINT");
    if (!(await this.waitForExit(SIGKILL_GRACE_MS))) {
      this.signal("SIGKILL");
      await this.waitForExit(SIGKILL_GRACE_MS);
    }
  }

  /**
   * Stops the process and what it started, and releases its streams. It is asked to stop first, so
   * it can flush the conversation it was writing, and killed if it has not gone by the grace
   * period. Safe to call repeatedly.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    this.signal("SIGTERM");
    if (!(await this.waitForExit(this.config.terminateGraceMs ?? TERMINATE_GRACE_MS))) {
      this.signal("SIGKILL");
      await this.waitForExit(SIGKILL_GRACE_MS);
    }
  }

  /** Signals the CLI and, when it leads a process group, everything in it. */
  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child) return;
    try {
      if (this.grouped && child.pid !== undefined) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone: there is nothing left to signal.
    }
  }

  /** Whether the process has exited and its exit was reported, within `ms`. */
  private async waitForExit(ms: number): Promise<boolean> {
    const exited = this.exitPromise;
    if (!exited || !this.child) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref();
    });
    try {
      return await Promise.race([exited.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
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
    if (!this.processExited || (this.readersPending > 0 && !this.drainExpired)) return;
    this.reported = true;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.child = null;
    const resolve = this.resolveExit;
    this.resolveExit = null;
    this.handlers.onExit(this.exitInfo);
    resolve?.();
  }
}
