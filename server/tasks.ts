import type { TranscriptEntry } from "./subagents";

/**
 * Background tasks as agy's conversation transcript reports them. agy's stream-json output says
 * nothing about a task once its command has moved to the background, so the transcript is the only
 * place a start or an end can be read from. Both are read from the fields agy structures, never
 * from the prose around them:
 *
 * - A task starts as a `GENERIC` step whose `status` is still `RUNNING`, and which carries the
 *   task's id on a `Tool is running as a background task with task id: <conversation>/task-N`
 *   line. The step is never rewritten when the task ends, so its status alone says nothing about
 *   the end. A step with any other status or type, such as a `view_file` result showing that same
 *   text, starts nothing.
 * - Whatever agy tells the model about a task is a `SYSTEM_MESSAGE` step whose `[Message]` header
 *   names the task as its `sender=`. That covers a task that finished (`priority=…HIGH`, "Task id
 *   … finished with result"), one that was canceled (`…LOW`, "was canceled with result"), a timer
 *   whose prompt fires, and a command whose output has stabilized. Any of these is agy reporting on
 *   the task, so the task is no longer one nobody has heard from, whatever the message says.
 *
 * Measured against the conversation databases of real runs (agy 1.2.11): the `steps` rows of task
 * steps (`step_type` 132) carry `status` 3 exactly for tasks that finished and 6 for the rest, but
 * agy documents neither value, so the transcript is used instead.
 */

const GENERIC = "GENERIC";
const USER_INPUT = "USER_INPUT";
const SYSTEM_MESSAGE = "SYSTEM_MESSAGE";
const RUNNING = "RUNNING";

/** The `key: value` line agy prints for a task a command was moved into. */
const TASK_ID_LINE = /^Tool is running as a background task with task id: (\S+)\s*$/m;
/** The header of one message inside a `SYSTEM_MESSAGE` step, at the start of its own line. */
const MESSAGE_HEADER = /^\[Message\] timestamp=(\S+) sender=(\S+) priority=(\S+) content=/gm;

export interface SystemMessage {
  readonly sender: string;
  readonly priority: string;
}

/** The messages a `SYSTEM_MESSAGE` step carries. Empty for text that only resembles the header. */
export function parseSystemMessages(content: string): SystemMessage[] {
  return [...content.matchAll(MESSAGE_HEADER)].flatMap((match) =>
    match[2] !== undefined && match[3] !== undefined ? [{ sender: match[2], priority: match[3] }] : [],
  );
}

/** The id of the task a step started, or null when the step is not the start of one. */
export function startedTaskId(entry: TranscriptEntry): string | null {
  if (entry.type !== GENERIC || entry.status !== RUNNING) return null;
  return TASK_ID_LINE.exec(entry.content ?? "")?.[1] ?? null;
}

/**
 * The tasks the prompt at or before `settledStep` started and agy has not reported on since. A task
 * from an earlier prompt is not this turn's to wait for, or to tell the user about.
 */
export function openBackgroundTasks(entries: readonly TranscriptEntry[], settledStep: number): Set<string> {
  let since = -1;
  for (const entry of entries) {
    if (entry.type === USER_INPUT && entry.stepIndex <= settledStep) since = Math.max(since, entry.stepIndex);
  }
  const open = new Set<string>();
  const sorted = entries
    .filter((entry) => entry.stepIndex > since)
    .sort((left, right) => left.stepIndex - right.stepIndex);
  for (const entry of sorted) {
    const started = startedTaskId(entry);
    if (started !== null) open.add(started);
    if (entry.type !== SYSTEM_MESSAGE) continue;
    for (const message of parseSystemMessages(entry.content ?? "")) open.delete(message.sender);
  }
  return open;
}
