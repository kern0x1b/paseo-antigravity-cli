/**
 * Opening a session (and undoing a failed open) and closing one.
 */

import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import { attachmentsDir, clearAttachments } from "./attachments";
import { stopBackfill, stopContinuation } from "./background";
import { DEFAULT_MODE_ID } from "./catalog";
import { discoverCommands } from "./commands";
import {
  mcpSessionConfigPath,
  removeSessionMcpConfig,
  sweepSessionMcpConfigs,
  writeSessionMcpConfig,
} from "./mcp";
import { persistenceFor, readConversationId } from "./persistence";
import { pluginDataDir, safePathSegment } from "./plugindata";
import { emitNotice } from "./publish";
import { replayItem } from "./replay";
import { checkAddDirs, configState, isSettingOn, readProviderOptions } from "./settings";
import {
  type ConnectionState,
  type Emit,
  liveSessions,
  requireSession,
  type Session,
} from "./state";
import { MAX_ITEMS, transcriptExists, TranscriptStore } from "./transcript";
import { attempt, describe } from "./util";

function insidePluginData(cwd: string): boolean {
  const own = resolve(pluginDataDir());
  const path = resolve(cwd);
  return path === own || path.startsWith(`${own}${sep}`);
}

export async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const config = input.config;
  if (insidePluginData(config.cwd)) {
    throw new Error(`${config.cwd} is where this plugin keeps its own files, not a workspace`);
  }
  const conversationId = readConversationId(input.persistence);
  const options = readProviderOptions(config);
  const persist = config.persist !== false;
  const attachmentsDir = await prepareAttachmentsDir(input.sessionId);
  const addDirs = await checkAddDirs(options.addDirs);

  // Computed before this session joins the map: a conversation with no timeline of this plugin's
  // own is one that already existed in Antigravity. Another open session's rows may still be
  // inside its write debounce, so those count as stored too.
  const knownHistory =
    conversationId !== null &&
    (transcriptExists(conversationId) ||
      [...state.sessions.values()].some(
        (other) => other.conversationId === conversationId && other.transcript !== null,
      ));

  const session: Session = {
    sessionId: input.sessionId,
    timing: state.timing,
    config,
    agyPath: options.agyPath,
    extraArgs: options.extraArgs,
    addDirs: addDirs.kept,
    settings: { ...config.settings },
    selection: {
      model: config.model,
      mode: config.mode ?? DEFAULT_MODE_ID,
      thinkingOption: config.thinkingOption,
    },
    conversationId,
    persist,
    transcript:
      persist && conversationId !== null ? await TranscriptStore.load(conversationId) : null,
    unpersisted: [],
    process: null,
    needsRestart: false,
    // One file per session: rewritten before each schema turn, removed on close.
    schemaPath: pluginDataDir("schemas", `${safePathSegment(input.sessionId)}.json`),
    launchPending: { schema: false, commands: false, skillDir: null },
    launchActive: { schema: false, commands: false, skillDir: null },
    attachmentsDir,
    attachmentCount: 0,
    mcp: "released",
    publishedSkills: new Set(),
    systemPromptSent: conversationId !== null,
    turnCounter: 0,
    pendingTurns: [],
    observed: new Map(),
    subagents: new Map(),
    follows: new Map(),
    childSessions: new Set(),
    stderrTail: [],
    agyError: null,
    interrupting: false,
    interruptEpoch: 0,
    promptChain: Promise.resolve(),
    closing: false,
    detached: null,
    continuation: null,
    deferred: [],
    settledStep: -1,
    pendingPlan: null,
    planApproval: state.capabilities.includes("permission"),
  };
  state.sessions.set(input.sessionId, session);
  liveSessions.add(input.sessionId);

  try {
    emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: input.sessionId,
      capabilities: state.capabilities,
      restoration: "core",
      persistence: persistenceFor(conversationId),
      title: config.title,
      cwd: config.cwd,
    });
    emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
    // The composer's command picker is filled from this event, and only what arrives before
    // `session.ready` reaches it — including for the throwaway probe a draft opens. Which of these
    // names this plugin expands itself is kept: a later prompt re-reads the roots, and this is what
    // separates a skill that has since disappeared from a name the CLI expands on its own.
    const discovered = await discoverCommands(config.cwd);
    session.publishedSkills = new Set(discovered.expanded.keys());
    emit({
      type: "session.commands",
      sessionId: input.sessionId,
      commands: [...discovered.commands],
    });

    await syncSessionMcp(session, emit);
    // Leftovers from a process that died without releasing its folders, and this is where the set
    // of live sessions is known.
    await sweepSessionMcpConfigs(liveSessions);
    if (session.mcp !== "applied" && Object.keys(config.mcpServers).length > 0) {
      emitNotice(
        session,
        emit,
        "mcp-unsupported",
        "warning",
        "MCP servers are not applied",
        `Antigravity reads MCP servers from ~/.gemini/config/mcp_config.json, and from .agents/mcp_config.json in a directory it was given. Turn on "Share Paseo tools with Antigravity" in the session settings to have Paseo write its ${Object.keys(config.mcpServers).length} server(s) to ${mcpSessionConfigPath(input.sessionId)}, a folder private to this session, or add them yourself with \`agy mcp add\`.`,
      );
    }
    if (addDirs.dropped.length > 0) {
      emitNotice(
        session,
        emit,
        "add-dirs-dropped",
        "warning",
        "Some extra directories were ignored",
        `providerOptions.addDirs only accepts absolute paths to existing directories. Not passed to Antigravity: ${addDirs.dropped.join(", ")}.`,
      );
    }
    if (conversationId !== null && !knownHistory) {
      // A conversation resumed from Antigravity's own store was never written by this plugin, so
      // there is nothing to replay. The history is not lost: the CLI still holds it.
      emitNotice(
        session,
        emit,
        "history-unavailable",
        "info",
        "Earlier history is not shown",
        "This conversation already existed in Antigravity, so its earlier turns are not part of Paseo's timeline and are not replayed. Antigravity still has them, and the next reply continues the conversation.",
      );
    }
    if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
      emitNotice(
        session,
        emit,
        "system-prompt-preamble",
        "info",
        "System prompt sent as a preamble",
        "Antigravity has no system-prompt flag, so it is prepended to the first message of the conversation.",
      );
    }

    if (input.history === "replay" && session.transcript?.truncated) {
      emitNotice(
        session,
        emit,
        "history-truncated",
        "info",
        "Only the most recent history is shown",
        `This conversation has more history than Paseo keeps. Only its most recent ${MAX_ITEMS} rows are shown here; Antigravity still has all of it, and the next reply continues the conversation.`,
      );
    }
    if (input.history === "replay" && session.transcript) {
      // A child's rows are replayed with the row that spawned it, before the parent announces
      // itself ready: a child session that arrived afterwards would be attached to a row the
      // client had already drawn.
      for (const item of session.transcript.list()) {
        await replayItem(session, emit, item);
      }
    }

    emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  } catch (error) {
    // A session that failed to open is not one: nothing may list it as running, hold its id, or
    // keep what it wrote.
    await abandonSession(state, session);
    throw error;
  }
}

/**
 * Undoes a session that never finished opening: it leaves the connection, and whatever it started
 * or wrote is stopped and removed. Every step is attempted, whatever happens to the others.
 */
async function abandonSession(state: ConnectionState, session: Session): Promise<void> {
  session.closing = true;
  state.sessions.delete(session.sessionId);
  liveSessions.delete(session.sessionId);
  stopContinuation(session);
  for (const turn of session.pendingTurns) stopBackfill(turn);
  for (const follow of session.follows.values()) follow.transcript.stop();
  session.follows.clear();
  const processes = [session.process, session.detached].filter((process) => process !== null);
  session.process = null;
  session.detached = null;
  await Promise.allSettled(processes.map((process) => process.dispose()));
  await attempt("remove the output schema", () => rm(session.schemaPath, { force: true }));
  await attempt("clear the attachments", () => clearAttachments(session.sessionId));
  await attempt("release the MCP entries", () => removeSessionMcpConfig(session.sessionId));
}

/**
 * Creates the folder attached images are written to. It is passed to every launch, so a session
 * that cannot create it still opens: plain turns run without the extra directory, and an image
 * prompt fails with `attachment_failed`.
 */
async function prepareAttachmentsDir(sessionId: string): Promise<string | null> {
  const dir = attachmentsDir(sessionId);
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    console.error(`[antigravity] could not create ${dir}: ${describe(error)}`);
    return null;
  }
}

/**
 * Makes the session's private MCP folder hold Paseo's servers exactly when the sharing toggle is
 * on. agy reads the file at startup, so this runs on the way to a launch: at `session.open`, and at
 * the start of a turn whose process is being replaced (the relaunch the toggle raises). A failed
 * attempt is reported once and left until the toggle is switched off and on again, rather than
 * re-reported on every turn.
 */
export async function syncSessionMcp(session: Session, emit: Emit): Promise<void> {
  const servers = session.config.mcpServers;
  if (!isSettingOn(session.settings.shareMcp) || Object.keys(servers).length === 0) {
    if (session.mcp === "released") return;
    session.mcp = "released";
    await removeSessionMcpConfig(session.sessionId);
    return;
  }
  if (session.mcp !== "released") return;

  const result = await writeSessionMcpConfig(session.sessionId, servers);
  if (result.status === "failed") {
    session.mcp = "error";
    emitNotice(
      session,
      emit,
      "mcp-config-failed",
      "warning",
      "Paseo tools were not shared",
      `${result.path} could not be written: ${result.message}`,
    );
    return;
  }
  session.mcp = "applied";
  emitNotice(
    session,
    emit,
    "mcp-shared",
    "warning",
    "Paseo tools are shared with Antigravity",
    `Antigravity loads Paseo's MCP servers from ${result.path}, in a folder that only this session's CLI is given, inside the plugin's own data directory and readable by you alone. That file holds the credentials those servers use (HTTP headers, or environment variables for stdio servers), and it is deleted when the session closes. Nothing is written into your workspace.`,
  );
}

export async function closeSession(
  input: Extract<ProviderInput, { type: "session.close" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  session.closing = true;
  const process = session.process;
  session.process = null;
  const detached = session.detached;
  session.detached = null;
  stopContinuation(session);
  session.deferred = [];
  for (const turn of session.pendingTurns) stopBackfill(turn);
  state.sessions.delete(input.sessionId);
  liveSessions.delete(input.sessionId);

  // Children first — those being followed and those a replay re-opened with no tailer behind them
  // — and all of them before the parent's `session.closed`: nothing may be published for a child
  // once its session is closed. Stopping the tailers before the awaits below is what makes that
  // true even if a transcript is being written right now.
  const children = [...session.follows.values()];
  session.follows.clear();
  for (const follow of children) follow.transcript.stop();

  // A session closes whatever goes wrong while it is cleaned up after: each step is attempted, the
  // CLI is stopped whatever became of the rows before it, and the host is told at the end.
  await attempt("write the timeline", () => session.transcript?.flush());
  for (const follow of children) await attempt("write a subagent's timeline", () => follow.store?.flush());
  await Promise.allSettled([process?.dispose(), detached?.dispose()]);
  await attempt("remove the output schema", () => rm(session.schemaPath, { force: true }));
  await attempt("clear the attachments", () => clearAttachments(session.sessionId));
  await attempt("release the MCP entries", () => removeSessionMcpConfig(session.sessionId));

  // Every child that settled already closed its own session and left this set, so what is left is
  // a child that was still running: closing it silently would tell the host it completed.
  for (const childId of session.childSessions) {
    emit({
      type: "session.closed",
      sessionId: childId,
      error: { message: "The session was closed before the subagent finished" },
    });
  }
  session.childSessions.clear();
  emit({ type: "session.closed", sessionId: input.sessionId });
  emit({ type: "request.completed", requestId: input.requestId });
}
