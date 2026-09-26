/**
 * One connection to the host: admitting inputs, dispatching them to the session that owns them,
 * and closing everything on the way out.
 */

import {
  type ProviderCapability,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  requireProviderCapabilities,
} from "@getpaseo/plugin/server/provider";
import { AgyProcess } from "./agy";
import { archiveConversation, archivedConversations, unarchiveConversation } from "./archive";
import { stopBackfill, stopContinuation } from "./background";
import { buildCatalog } from "./catalog";
import { closeSession, openSession } from "./lifecycle";
import { removeSessionMcpConfig } from "./mcp";
import { readConversationId } from "./persistence";
import { respondToPermission } from "./plan";
import { listConversations } from "./sessions";
import { type ConnectionState, type Emit, liveSessions } from "./state";
import type { Timing } from "./timing";
import { configureSession, interruptSession, promptSession } from "./turns";
import { describe } from "./util";

export function createConnection(capabilities: readonly ProviderCapability[], timing: Timing): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const state: ConnectionState = { capabilities, timing, sessions: new Map() };
  let closed = false;

  const emit: Emit = (event) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Antigravity provider connection is closed");
      console.log(`[antigravity] input ${describeInput(input)}`);
      validateAdmission(input, state);
      await dispatch(input, state, emit);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const running: AgyProcess[] = [];
      const flushing: Array<() => Promise<void>> = [];
      const sessionIds: string[] = [];
      for (const session of state.sessions.values()) {
        session.closing = true;
        sessionIds.push(session.sessionId);
        if (session.process) running.push(session.process);
        if (session.detached) running.push(session.detached);
        session.process = null;
        session.detached = null;
        stopContinuation(session);
        for (const turn of session.pendingTurns) stopBackfill(turn);
        const transcript = session.transcript;
        if (transcript) flushing.push(() => transcript.flush());
        // A child is followed by a watcher and a timer of its own, and its rows live in a store of
        // its own: both end with the connection that started them.
        for (const follow of session.follows.values()) {
          follow.transcript.stop();
          const store = follow.store;
          if (store) flushing.push(() => store.flush());
        }
        session.follows.clear();
      }
      for (const id of sessionIds) liveSessions.delete(id);
      state.sessions.clear();
      listeners.clear();
      // The rows of the last turn are still inside the debounce window, so flushing before the
      // processes are disposed is what lets a reload replay the answer that just finished. Every
      // step runs whatever becomes of the others: a CLI must not outlive the connection because
      // something before it failed.
      await Promise.allSettled(flushing.map((flush) => flush()));
      await Promise.allSettled(running.map((process) => process.dispose()));
      // A close without a session.close: entries this connection injected still belong to it.
      await Promise.allSettled(sessionIds.map((id) => removeSessionMcpConfig(id)));
    },
  };
}

function validateAdmission(input: ProviderInput, state: ConnectionState): void {
  if (input.type === "session.open") {
    if (state.sessions.has(input.sessionId)) {
      throw new Error(`Session already exists: ${input.sessionId}`);
    }
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!("sessionId" in input)) {
    requireProviderCapabilities(state.capabilities, input);
    return;
  }
  if (!state.sessions.has(input.sessionId)) {
    throw new Error(`Unknown session: ${input.sessionId}`);
  }
  requireProviderCapabilities(state.capabilities, input);
}

async function dispatch(input: ProviderInput, state: ConnectionState, emit: Emit): Promise<void> {
  switch (input.type) {
    case "catalog":
      emit({ type: "catalog", requestId: input.requestId, catalog: await buildCatalog() });
      return;
    case "sessions": {
      // A conversation a session is running, or one that was archived, is not one to import.
      const running = runningConversations(state);
      const archived = await archivedConversations();
      emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: listConversations({
          cwd: input.cwd,
          query: input.query,
          limit: input.limit,
          exclude: (id) => running.has(id) || archived.has(id),
        }),
      });
      return;
    }
    case "session.archive":
    case "session.unarchive":
      await setArchived(input, emit);
      return;
    case "session.open":
      await openSession(input, state, emit);
      return;
    case "session.prompt":
      await promptSession(input, state, emit);
      return;
    case "session.interrupt":
      await interruptSession(input, state, emit);
      return;
    case "session.permission":
      await respondToPermission(input, state, emit);
      return;
    case "session.configure":
      await configureSession(input, state, emit);
      return;
    case "session.close":
      await closeSession(input, state, emit);
      return;
    default:
      throw new Error(`Unsupported provider input: ${(input as { type: string }).type}`);
  }
}

/** Archives or unarchives the conversation a request names, and says how it went. */
async function setArchived(
  input: Extract<ProviderInput, { type: "session.archive" | "session.unarchive" }>,
  emit: Emit,
): Promise<void> {
  const conversationId = readConversationId(input.persistence);
  if (conversationId === null) {
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: "The persistence handle names no Antigravity conversation", code: "invalid_persistence" },
    });
    return;
  }
  try {
    if (input.type === "session.archive") await archiveConversation(conversationId);
    else await unarchiveConversation(conversationId);
  } catch (error) {
    emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `Could not record the change: ${describe(error)}`, code: "archive_failed" },
    });
    return;
  }
  emit({ type: "request.completed", requestId: input.requestId });
}

/**
 * Conversations that a session of this connection is running. Paseo offers listed conversations for
 * import, and one listed while its own session is still on its first turn would be imported a second
 * time as a new agent.
 */
function runningConversations(state: ConnectionState): Set<string> {
  const ids = new Set<string>();
  for (const session of state.sessions.values()) {
    if (!session.closing && session.conversationId) ids.add(session.conversationId);
  }
  return ids;
}

/**
 * Daemon-side trace of protocol traffic. Prompt and system-prompt contents are reduced to lengths
 * because the retained plugin log tail is readable by anyone connected to this daemon.
 */
function describeInput(input: ProviderInput): string {
  switch (input.type) {
    case "catalog":
      return `catalog cwd=${input.cwd ?? "-"}`;
    case "sessions":
      return `sessions query=${input.query ?? "-"}`;
    case "session.open":
      return [
        "session.open",
        `session=${input.sessionId}`,
        `cwd=${input.config.cwd}`,
        `model=${input.config.model ?? "-"}`,
        `thinkingOption=${input.config.thinkingOption ?? "-"}`,
        `mode=${input.config.mode ?? "-"}`,
        `mcpServers=${Object.keys(input.config.mcpServers).length}`,
        `toolPolicy=${input.config.toolPolicy ? input.config.toolPolicy.preapproved.length : 0}`,
        `history=${input.history}`,
        `resume=${input.persistence ? "yes" : "no"}`,
        `systemPrompt=${input.config.systemPrompt?.length ?? 0}chars`,
        `settings=${JSON.stringify(input.config.settings)}`,
      ].join(" ");
    case "session.prompt": {
      const content = input.prompt.input.type === "message" ? input.prompt.input.content : [];
      const textChars = content.reduce(
        (total, part) => total + (part.type === "text" ? part.text.length : 0),
        0,
      );
      return [
        "session.prompt",
        `session=${input.sessionId}`,
        `delivery=${input.prompt.delivery}`,
        `kind=${input.prompt.input.type}`,
        ...(input.prompt.input.type === "command" ? [`name=${input.prompt.input.name}`] : []),
        `parts=${content.length}`,
        `images=${content.filter((part) => part.type === "image").length}`,
        `text=${textChars}chars`,
        `schema=${input.prompt.outputSchema === undefined ? "no" : "yes"}`,
      ].join(" ");
    }
    case "session.configure":
      return `session.configure session=${input.sessionId} changes=${JSON.stringify(input.changes)}`;
    case "session.interrupt":
      return `session.interrupt session=${input.sessionId}`;
    case "session.close":
      return `session.close session=${input.sessionId}`;
    default:
      return input.type;
  }
}
