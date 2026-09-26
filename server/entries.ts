/**
 * One step of a transcript agy writes — `~/.gemini/antigravity-cli/brain/<conversation>/
 * .system_generated/logs/transcript.jsonl`, for a conversation or for a subagent's own — and how a
 * line of it is read. Lines are appended while a conversation runs, several at once, and a step may
 * land before its predecessor (step 2 before step 1 was observed), so nothing here assumes file
 * order.
 */

export interface TranscriptToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface TranscriptEntry {
  readonly stepIndex: number;
  /** The line's `type`, exactly as written. */
  readonly type: string;
  /** The step's `error`, which an `ERROR_MESSAGE` step carries in place of content. */
  readonly error?: string;
  /** The line's `status` (`DONE`, `RUNNING`, `ERROR`), when it has one. */
  readonly status?: string;
  /** Who wrote the step: `MODEL`, `SYSTEM` or `USER_EXPLICIT`. */
  readonly source?: string;
  readonly content?: string;
  readonly toolCalls: readonly TranscriptToolCall[];
}

export interface ParsedTranscript {
  /** In the order the steps were first seen; `renderChild` sorts them. */
  readonly entries: TranscriptEntry[];
  /** Complete lines that were not a JSON step, reported instead of thrown away silently. */
  readonly malformed: number;
}

/** One line of a transcript: the step it holds, or null when the line is not a step. */
export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  const stepIndex = record.step_index;
  const type = record.type;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex)) return null;
  if (typeof type !== "string" || type.length === 0) return null;
  return {
    stepIndex,
    type,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.error === "string" && record.error.length > 0 ? { error: record.error } : {}),
    toolCalls: readToolCalls(record.tool_calls),
  };
}

/**
 * Parses what a transcript holds right now. Only complete lines count: the last line of a file
 * being appended to is a write in progress, not a broken step.
 */
export function parseTranscriptLines(text: string): ParsedTranscript {
  // `split` never loses a trailing newline's emptiness: dropping the final element drops either
  // that empty tail or the unterminated line itself.
  const complete = text.split("\n").slice(0, -1);
  const byStep = new Map<number, TranscriptEntry>();
  let malformed = 0;

  for (const line of complete) {
    if (line.trim().length === 0) continue;
    const entry = parseTranscriptLine(line);
    if (entry === null) malformed += 1;
    else byStep.set(entry.stepIndex, entry);
  }

  return { entries: [...byStep.values()], malformed };
}

function readToolCalls(value: unknown): TranscriptToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: TranscriptToolCall[] = [];
  for (const call of value) {
    if (typeof call !== "object" || call === null || Array.isArray(call)) continue;
    const record = call as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    const args = record.args;
    calls.push({
      name: record.name,
      args: typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
    });
  }
  return calls;
}
