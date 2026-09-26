/**
 * Prompts and turns: preparing a prompt, starting a turn, writing it to a CLI, and stopping or
 * reconfiguring the session around it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderContent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { writeAttachment } from "./attachments";
import { isContinuing, releaseDetached } from "./background";
import { discoverCommands, MAX_SKILL_BYTES, renderSkillPrompt } from "./commands";
import { PLAN_MODE_ID, PLAN_MODE_PREAMBLE } from "./constants";
import { syncSessionMcp } from "./lifecycle";
import { resolvePendingPlan } from "./plan";
import { ensureProcess } from "./process";
import { failPrompt, publish } from "./publish";
import { configState } from "./settings";
import {
  announceTurn,
  type ConnectionState,
  createPendingTurn,
  type Emit,
  type LaunchProfile,
  type PendingTurn,
  requireSession,
  type Session,
  type TurnRequest,
} from "./state";
import { describe } from "./util";

/**
 * Runs prompt work one prompt at a time, in the order the prompts arrived. Preparing a prompt
 * awaits (a restart, an MCP sync, an attachment write), and two prompts preparing at once would
 * each be judged against a session that has not yet seen the other. Work that fails does not stop
 * the ones behind it.
 */
export function enqueuePrompt(session: Session, work: () => Promise<void>): Promise<void> {
  const run = session.promptChain.then(work);
  session.promptChain = run.catch(() => undefined);
  return run;
}

export async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  // A stop that arrives after this prompt did applies to it, even if it is still being prepared.
  const epoch = session.interruptEpoch;
  await enqueuePrompt(session, () => prepareAndStartPrompt(session, input, emit, epoch));
}

async function prepareAndStartPrompt(
  session: Session,
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  emit: Emit,
  epoch: number,
): Promise<void> {
  if (session.closing) return;
  const { prompt } = input;
  const stopped = (): boolean => {
    if (session.interruptEpoch === epoch) return false;
    failPrompt(session, emit, prompt.clientMessageId, {
      message: "The prompt was stopped before it started",
      code: "interrupted",
    });
    return true;
  };

  // Which command the user picked decides the launch, so the list is read again here rather than
  // trusted from `session.open`: a skill may have been installed, removed, or renamed since.
  const command = prompt.input.type === "command" ? prompt.input : null;
  const discovered = command === null ? null : await discoverCommands(session.config.cwd);
  const skill = command === null ? null : (discovered?.expanded.get(command.name) ?? null);
  const unlisted =
    command !== null &&
    discovered !== null &&
    !discovered.commands.some((entry) => entry.name === command.name);
  // The composer offered this name as one this plugin expands, and the roots no longer have it:
  // sending `/<name>` would only get the model answering the literal text.
  if (skill === null && command !== null && unlisted && session.publishedSkills.has(command.name)) {
    failPrompt(session, emit, prompt.clientMessageId, {
      message: `The skill "${command.name}" is no longer installed where this plugin expands skills from (~/.agents/skills). Reinstall it, or reopen the session if it was just added.`,
      code: "skill_unavailable",
    });
    return;
  }
  const profile: LaunchProfile = {
    schema: prompt.outputSchema !== undefined,
    // A plugin-expanded skill never reaches the CLI as a slash name, so it needs no expansion —
    // and must not have it, or a body containing `/...` could be parsed as a command.
    commands: command !== null && skill === null,
    skillDir: skill?.dir ?? null,
  };
  // `--json-schema`, `--add-dir` and `--disable-slash-commands` belong to the process, not the
  // turn, and the CLI cannot be replaced while it still owes a turn — so a prompt whose profile
  // the running CLI cannot serve is refused rather than queued into it.
  const refusal = queuedRefusal(session, profile);
  if (refusal !== null) {
    failPrompt(session, emit, prompt.clientMessageId, { message: refusal, code: "busy" });
    return;
  }

  // Read before the turn is announced: a skill that vanished since the picker was filled fails
  // the prompt instead of starting a turn the CLI cannot answer.
  let expanded: string | null = null;
  if (command !== null && skill !== null) {
    const rendered = await renderSkillPrompt(skill, command.arguments.trim());
    if (rendered.kind !== "text") {
      failPrompt(session, emit, prompt.clientMessageId, {
        message:
          rendered.kind === "too_large"
            ? `${skill.path} is ${rendered.bytes} bytes, and this plugin sends at most ${MAX_SKILL_BYTES / 1024} KiB of a skill it expands itself. Install the skill for Antigravity itself (see the README) or shorten it.`
            : `The skill "${skill.name}" could not be read: ${rendered.message}. Reinstall it, or run \`/skills reload\` in Antigravity if it was just installed.`,
        code: rendered.kind === "too_large" ? "skill_too_large" : "skill_unavailable",
      });
      return;
    }
    expanded = rendered.text;
  }

  if (profile.schema) {
    try {
      await mkdir(dirname(session.schemaPath), { recursive: true });
      await writeFile(session.schemaPath, JSON.stringify(prompt.outputSchema), "utf8");
    } catch (error) {
      failPrompt(session, emit, prompt.clientMessageId, {
        message: `Could not write the output schema for Antigravity: ${describe(error)}`,
        code: "schema_failed",
      });
      return;
    }
  }
  session.launchPending = profile;

  // A schema prompt always gets a fresh CLI (the file it read may have changed since), and any
  // prompt that needs the other profile must not be served by the process running now.
  const sameLaunch =
    session.launchActive.schema === profile.schema &&
    session.launchActive.commands === profile.commands &&
    session.launchActive.skillDir === profile.skillDir;
  if (session.process?.running && (!sameLaunch || profile.schema)) session.needsRestart = true;
  await releaseDetached(session);
  await applyPendingRestart(session);
  // The CLI reads the workspace MCP config at startup and only this path spawns one, so a toggle
  // change lands here; a turn queued behind a running one waits for its own relaunch instead.
  if (session.pendingTurns.length === 0) await syncSessionMcp(session, emit);
  if (stopped()) return;
  // Typing a new message instead of answering the plan prompt is the user choosing to keep
  // planning, so the prompt is withdrawn rather than left to answer a plan that moved on.
  resolvePendingPlan(session, emit);

  // What the timeline shows the user typed, and what the CLI is actually sent. A native command
  // is expanded by the CLI, so both are the same `/<name> <arguments>`; a plugin-expanded skill is
  // sent as the skill's own instructions, while the row still reads the command that was picked.
  let typed = "";
  let text = "";
  if (command !== null) {
    const args = command.arguments.trim();
    // The leading `/name` is what the CLI expands, so it goes out as the first token of the turn.
    typed = args.length > 0 ? `/${command.name} ${args}` : `/${command.name}`;
    text = expanded ?? typed;
  } else if (prompt.input.type === "message") {
    try {
      text = await renderPromptContent(session, prompt.input.content);
    } catch (error) {
      failPrompt(session, emit, prompt.clientMessageId, {
        message: `Could not attach the prompt's image: ${describe(error)}`,
        code: "attachment_failed",
      });
      return;
    }
  }
  if (text.trim().length === 0) {
    failPrompt(session, emit, prompt.clientMessageId, {
      message: "Antigravity requires a non-empty text prompt",
      code: "empty_prompt",
    });
    return;
  }

  if (stopped() || session.closing) return;
  await startTurn(session, emit, {
    shown: typed.length > 0 ? typed : text,
    text,
    clientMessageId: prompt.clientMessageId,
    // The CLI expands `/name` only as the first token of a turn, so nothing may be put before a
    // command the CLI expands itself.
    verbatim: command !== null && expanded === null,
  });
}

export async function startTurn(session: Session, emit: Emit, request: TurnRequest): Promise<void> {
  const plan = session.selection.mode === PLAN_MODE_ID && !request.verbatim;
  const turn = createPendingTurn(session, plan);

  publish(session, emit, {
    type: "user_message",
    id: `user:${turn.turnId}`,
    text: request.shown,
    ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
  });
  if (request.clientMessageId !== undefined) {
    emit({
      type: "session.prompt_result",
      sessionId: session.sessionId,
      clientMessageId: request.clientMessageId,
      result: { type: "turn", turnId: turn.turnId },
    });
  }

  if (request.verbatim) {
    // The system prompt's preamble waits for the first plain message.
    turn.outgoing = request.text;
  } else {
    const wanted = plan ? `${PLAN_MODE_PREAMBLE}\n\n${request.text}` : request.text;
    turn.carriesSystemPrompt = !session.systemPromptSent && hasSystemPrompt(session);
    turn.outgoing = buildOutgoingText(session, wanted);
    session.systemPromptSent = true;
  }
  // The detached CLI is carrying the conversation on, and the only way to hand this turn to a CLI
  // would be to kill that one mid-way. The turn is accepted now and started once it is written,
  // so the host is not told it is running while the conversation is busy with another turn.
  if (isContinuing(session) || session.deferred.length > 0) {
    console.log(`[antigravity] ${turn.turnId} waits for the conversation to finish carrying on`);
    session.deferred.push(turn);
    return;
  }
  await writePendingTurn(session, emit, turn);
}

/** Hands a turn to the CLI, or fails it when no CLI can take it. */
export async function writePendingTurn(session: Session, emit: Emit, turn: PendingTurn): Promise<void> {
  try {
    // Picking the process first: replacing a CLI whose stdin died settles the turns that CLI still
    // owed, and this turn must not be counted among them.
    const process = ensureProcess(session, emit);
    turn.schema = session.launchActive.schema;
    // A turn queued behind another is started when that one is over, not when it is written.
    if (session.pendingTurns.length === 0) announceTurn(session, emit, turn);
    session.pendingTurns.push(turn);
    await process.writeTurn(turn.outgoing);
  } catch (error) {
    // The exit of the CLI may have failed the turn first; it ends once.
    const owned = session.pendingTurns.includes(turn);
    session.pendingTurns = session.pendingTurns.filter((pending) => pending !== turn);
    if (!owned && turn.announced) return;
    releaseSystemPrompt(session, turn);
    announceTurn(session, emit, turn);
    emit({
      type: "session.turn",
      sessionId: session.sessionId,
      turnId: turn.turnId,
      state: "failed",
      error: { message: describe(error), code: "agy_launch_failed" },
    });
  }
}

/** The system prompt travels with the first plain turn; one that never got an answer sends it again. */
export function releaseSystemPrompt(session: Session, turn: PendingTurn): void {
  if (turn.carriesSystemPrompt && !turn.hadAssistantText) session.systemPromptSent = false;
}

/**
 * Why a prompt cannot be queued behind the turn already running, or null when it can. agy serves
 * every turn of a process with that process's launch flags, so a prompt that needs the other
 * profile would be answered under the wrong ones, and the CLI cannot be replaced until the turn it
 * still owes has finished.
 */
function queuedRefusal(session: Session, profile: LaunchProfile): string | null {
  const deferring = isContinuing(session) || session.deferred.length > 0;
  if (session.pendingTurns.length === 0 && !deferring) return null;
  if (profile.schema) {
    return "Antigravity applies a structured-output schema to the whole process, so this prompt cannot be queued behind a running turn. Wait for the turn to finish and send it again.";
  }
  if (profile.commands) {
    return "Antigravity expands slash commands only on a CLI launched without --disable-slash-commands, and that CLI cannot be replaced while it is still answering. Wait for the turn to finish and send the command again.";
  }
  if (profile.skillDir !== null) {
    return "This skill is expanded by the plugin, which gives the CLI the skill's own directory for that turn alone, and the CLI cannot be replaced while it is still answering. Wait for the turn to finish and send the command again.";
  }
  // A deferred turn is written to a CLI launched for it, so the detached one's flags do not apply.
  if (session.pendingTurns.length === 0) return null;
  if (session.launchActive.schema) {
    return "Antigravity is answering a structured-output request, and applies its schema to every turn of that process. Wait for the turn to finish and send this again.";
  }
  if (session.launchActive.commands) {
    return "Antigravity is running a slash command on a CLI launched without --disable-slash-commands, so a plain message could be expanded as a command instead of answered. Wait for the turn to finish and send it again.";
  }
  if (session.launchActive.skillDir !== null) {
    return "Antigravity is running a turn that was given an extra skill directory, and that CLI cannot be replaced while it is still answering. Wait for the turn to finish and send this again.";
  }
  return null;
}

export async function interruptSession(
  input: Extract<ProviderInput, { type: "session.interrupt" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  session.interruptEpoch += 1;
  // A continuation is the detached CLI's turn, so stopping it stops that CLI; its exit settles the
  // continuation and the turns deferred behind it (see `handleDetachedExit`).
  const process = session.process ?? (isContinuing(session) ? session.detached : null);
  if (process?.running) {
    session.interrupting = true;
    try {
      await process.interrupt();
    } finally {
      session.interrupting = false;
    }
  }
  // agy normally reports `result.error = "interrupted"` before exiting, which resolves the turn.
  // If it died without one, the exit handler cancels whatever is still pending.
  emit({ type: "request.completed", requestId: input.requestId });
}

export async function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const changes = input.changes;

  if (changes.model !== undefined) {
    session.selection.model = changes.model === null ? undefined : changes.model;
  }
  if (changes.mode !== undefined) {
    session.selection.mode = changes.mode === null ? undefined : changes.mode;
  }
  if (changes.thinkingOption !== undefined) {
    session.selection.thinkingOption =
      changes.thinkingOption === null ? undefined : changes.thinkingOption;
  }
  if (changes.settings) {
    session.settings = { ...session.settings, ...changes.settings };
  }

  // agy fixes the model, mode, and approval flags at launch, so a change is applied by restarting
  // the CLI. That restart is deferred to the start of the next turn: killing the process here
  // would abort an answer that is already streaming just because a selector moved.
  if (session.process?.running) session.needsRestart = true;

  emit({ type: "session.config", sessionId: session.sessionId, config: configState(session) });
  emit({ type: "request.completed", requestId: input.requestId });
}

/**
 * Restarts the CLI so newly selected launch flags take effect. The Antigravity conversation id is
 * passed back through `--conversation`, so the history survives the restart.
 */
export async function applyPendingRestart(session: Session): Promise<void> {
  if (!session.needsRestart || session.pendingTurns.length > 0) return;
  session.needsRestart = false;

  const process = session.process;
  if (!process) return;
  session.process = null;
  console.log("[antigravity] restarting the CLI with updated settings");
  await process.dispose();
}

/** Antigravity has no system-prompt flag, so it is prepended to the first turn of a conversation. */
function hasSystemPrompt(session: Session): boolean {
  return (session.config.systemPrompt?.trim().length ?? 0) > 0;
}

function buildOutgoingText(session: Session, text: string): string {
  if (session.systemPromptSent) return text;
  const systemPrompt = session.config.systemPrompt?.trim();
  if (!systemPrompt) return text;
  return `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${text}`;
}

/**
 * Renders the prompt's parts for agy's text-only stream input. An image part is written to the
 * session's attachments folder and referenced by absolute path: agy rejects image content blocks
 * outright, but reads an image file with `view_file` (probed 2026-09-23).
 */
async function renderPromptContent(
  session: Session,
  content: readonly ProviderContent[],
): Promise<string> {
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "image") {
      if (session.attachmentsDir === null) {
        throw new Error("the attachments folder could not be created");
      }
      session.attachmentCount += 1;
      const path = await writeAttachment(
        session.sessionId,
        session.attachmentCount,
        part.data,
        part.mimeType,
      );
      parts.push(`[image attached: ${path} — view it with view_file]`);
      continue;
    }
    parts.push(renderPart(part));
  }
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function renderPart(part: Exclude<ProviderContent, { type: "image" }>): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "uploaded_file":
      return `[uploaded file: ${part.path}]`;
    case "review":
      return renderReview(part);
    case "forge_change_request":
    case "forge_issue":
    case "github_pr":
    case "github_issue": {
      const header = `[${part.title}](${part.url})`;
      return part.body ? `${header}\n\n${part.body}` : header;
    }
    default:
      return "";
  }
}

function renderReview(part: Extract<ProviderContent, { type: "review" }>): string {
  const lines = [`[code review · ${part.mode}] ${part.cwd}`];
  for (const comment of part.comments) {
    lines.push(`\n${comment.filePath}:${comment.lineNumber} (${comment.side})\n${comment.body}`);
  }
  return lines.join("\n");
}
