/**
 * The agy process of a session: launching it, reacting to its exit, and retiring it.
 */

import type { ProviderError } from "@getpaseo/plugin/server/provider";
import { AgyProcess } from "./agy";
import { handleDetachedExit } from "./background";
import { resolveThinking } from "./catalog";
import { STDERR_TAIL } from "./constants";
import { mcpSessionDir } from "./mcp";
import { parseAgyErrorLine } from "./protocol";
import { approvalPolicy, isSettingOn } from "./settings";
import type { Emit, Session, TurnFailure } from "./state";
import { handleAgyEvent } from "./stream";
import { emitUnavailableNotice, endTurn, turnFailure } from "./turn-end";
import { describe, runInBackground } from "./util";

export function ensureProcess(session: Session, emit: Emit): AgyProcess {
  const current = session.process;
  if (current?.running) {
    if (current.acceptsInput) return current;
    // A CLI that lost its stdin can neither take this turn nor finish the ones it still owes, so
    // settle those turns and replace it. Its own exit is ignored below: it no longer owns the
    // session, and failing the new process's turns from it would be wrong.
    handleAgyExit(session, { code: null, signal: null }, emit);
    runInBackground("stop the previous CLI", current.dispose());
  }

  const process = new AgyProcess(
    {
      cwd: session.config.cwd,
      env: session.config.env,
      model: resolveThinking(session.selection.model, session.selection.thinkingOption).slug,
      mode: session.selection.mode,
      conversationId: session.conversationId ?? undefined,
      sandbox: isSettingOn(session.settings.sandbox),
      addDirs: session.addDirs,
      skipPermissions: approvalPolicy(session) === "skip",
      outputSchemaPath: session.launchPending.schema ? session.schemaPath : undefined,
      allowSlashCommands: session.launchPending.commands,
      attachmentDir: session.attachmentsDir ?? undefined,
      skillDir: session.launchPending.skillDir ?? undefined,
      mcpDir: session.mcp === "applied" ? mcpSessionDir(session.sessionId) : undefined,
      extraArgs: session.extraArgs,
      binary: session.agyPath,
      terminateGraceMs: session.timing.terminateGraceMs,
      drainGraceMs: session.timing.drainGraceMs,
    },
    {
      // A replaced CLI keeps writing events and stderr until it dies; none of it belongs to the
      // turns of the process that replaced it.
      onEvent: (event) => {
        if (session.process !== process) return;
        // Runs from the CLI's output reader, where a throw would be an uncaught exception in the
        // plugin host — and the host does throw here when it refuses an event.
        try {
          handleAgyEvent(session, event, emit);
        } catch (error) {
          try {
            failEverythingPending(session, emit, process, {
              message: `The Antigravity provider failed while handling the CLI's output: ${describe(error)}`,
              code: "internal_error",
            });
          } catch (again) {
            // The host refuses the failure too; the CLI is already stopped, and nothing else can be done.
            console.error(`[antigravity] could not report the failure either: ${describe(again)}`);
          }
        }
      },
      onStderr: (line) => {
        if (session.process !== process) return;
        session.stderrTail.push(line);
        if (session.stderrTail.length > STDERR_TAIL) session.stderrTail.shift();
        session.agyError = parseAgyErrorLine(line) ?? session.agyError;
        console.error(`[antigravity] ${line}`);
      },
      onExit: (info) => {
        if (session.detached === process) {
          handleDetachedExit(session, emit);
          return;
        }
        if (session.process !== process) return;
        handleAgyExit(session, info, emit);
      },
    },
  );

  session.process = process;
  // What this launch actually got, so the next prompt can tell whether it needs its own one.
  session.launchActive = session.launchPending;
  // The tail explains *this* process's failure; leftovers from a previous launch would be quoted
  // as if they came from the run that just died. The same holds for the structured error line.
  session.stderrTail = [];
  session.agyError = null;
  process.start();
  return process;
}

/** Stops using a CLI: a fresh one serves the next turn, and this one is stopped in the background. */
export function retireProcess(session: Session, process: AgyProcess): void {
  if (session.process === process) session.process = null;
  runInBackground("stop the CLI", process.dispose());
}

/**
 * Ends every turn a CLI still owes with `error` and stops using it. For a CLI whose state can no
 * longer be trusted — it sent something unreadable, or the provider failed while handling it.
 */
export function failEverythingPending(session: Session, emit: Emit, process: AgyProcess, error: ProviderError): void {
  console.error(`[antigravity] ${error.message}`);
  const pending = session.pendingTurns;
  session.pendingTurns = [];
  retireProcess(session, process);
  for (const turn of pending) endTurn(session, emit, turn, { state: "failed", error });
}

function handleAgyExit(
  session: Session,
  info: { code: number | null; signal: NodeJS.Signals | null },
  emit: Emit,
): void {
  session.process = null;
  if (session.closing) return;

  const pending = session.pendingTurns;
  session.pendingTurns = [];
  if (pending.length === 0) return;

  // agy writes its diagnostics to stderr, which is where an invalid model or a missing sign-in
  // shows up, so surface the tail rather than a bare exit code.
  const tail = session.stderrTail.slice(-3).join(" ");
  const detail =
    tail.length > 0
      ? tail
      : `Antigravity exited (code ${info.code ?? "none"}${info.signal ? `, signal ${info.signal}` : ""})`;
  // A canceled turn is not an API failure, so the structured error line of the process that
  // happened to be signalled must not be reported as its cause.
  const failure: TurnFailure = session.interrupting
    ? { error: { message: detail, code: "interrupted" }, retryable: false }
    : turnFailure(session, { message: detail, code: "agy_exit" });

  for (const turn of pending) {
    endTurn(session, emit, turn, { state: session.interrupting ? "canceled" : "failed", error: failure.error });
  }
  if (failure.retryable) emitUnavailableNotice(session, emit);
}
