import { z } from "zod";

/**
 * Decoders for the NDJSON event stream produced by
 * `agy --input-format stream-json --output-format stream-json`.
 *
 * Every line is one JSON object with an `event` discriminator. Observed kinds:
 *   init         -> { conversation_id, init: { cwd, tools, permission_mode } }
 *   step_update  -> { step_update: { step_index, state, step_type, ... } }
 *   result       -> { result: { status, response, error?, num_turns, usage } } (one per turn)
 *
 * Only what an event cannot do without is required — the step's index, state and type, the result's
 * status. Every other field is decoded leniently: one that is missing or has an unusable value
 * becomes `undefined` instead of failing the line, because a schema drift in `usage` must not cost
 * the `result` that ends the turn. Unknown kinds are dropped, and a known kind that still cannot be
 * decoded is reported as `malformed` so the caller can log it and, for a `result`, fail the turn.
 */

/** An optional field that reads as absent when its value is unusable. */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const usageSchema = z.object({
  input_tokens: lenient(z.number()),
  output_tokens: lenient(z.number()),
  thinking_tokens: lenient(z.number()),
  cache_read_tokens: lenient(z.number()),
  total_tokens: lenient(z.number()),
});

const initSchema = z.object({
  // An empty id shows up on an eligibility failure and would name a transcript file ".jsonl".
  conversation_id: z.string().min(1),
  init: lenient(
    z.object({
      cwd: lenient(z.string()),
      tools: lenient(z.array(z.string())),
      permission_mode: lenient(z.string()),
    }),
  ),
});

const toolInfoSchema = z.object({
  name: lenient(z.string()),
  parameters: lenient(z.record(z.string(), z.unknown())),
  output: lenient(z.string()),
});

/** One child an `invoke_subagent` step spawned, as the subagent line reports it. */
const subagentSchema = z.looseObject({
  type_name: lenient(z.string()),
  role: lenient(z.string()),
  initial_prompt: lenient(z.string()),
  conversation_id: lenient(z.string()),
  /** `file:` URL of the child's own transcript, which is how a child can be followed. */
  log_uri: lenient(z.string()),
  workspace_uris: lenient(z.array(z.string())),
});

/**
 * A subagent step's payload. A shape agy cannot decode becomes `undefined` rather than failing the
 * step: dropping it would also lose the row the `invoke_subagent` tool line had already published,
 * while the children a malformed payload names are information this plugin can do without.
 */
const subagentInfoSchema = z
  .looseObject({ subagents: z.array(subagentSchema).optional() })
  .optional()
  .catch(undefined);

const stepUpdateSchema = z.object({
  conversation_id: lenient(z.string()),
  step_index: z.number(),
  state: z.string(),
  step_type: z.string(),
  /** Incremental text chunk, not a snapshot. Absent on non-text steps. */
  text_delta: lenient(z.string()),
  tool_name: lenient(z.string()),
  tool_info: lenient(toolInfoSchema),
  subagent_info: subagentInfoSchema,
  duration_seconds: lenient(z.number()),
  usage: lenient(usageSchema),
});

const resultSchema = z.object({
  conversation_id: lenient(z.string()),
  status: z.string(),
  response: lenient(z.string()),
  error: lenient(z.string()),
  duration_seconds: lenient(z.number()),
  num_turns: lenient(z.number()),
  usage: lenient(usageSchema),
  /**
   * Present only when the process was launched with `--json-schema`: the model's answer decoded
   * against that schema. `response` then repeats the same JSON with extra `toolAction` /
   * `toolSummary` keys, so it is never the answer Paseo should show.
   */
  structured_output: z.unknown().optional(),
  json_schema: z.unknown().optional(),
});

export type AgyUsage = z.infer<typeof usageSchema>;
export type AgyStepUpdate = z.infer<typeof stepUpdateSchema>;
export type AgyToolInfo = z.infer<typeof toolInfoSchema>;
export type AgyResult = z.infer<typeof resultSchema>;

export type AgyEvent =
  | { kind: "init"; conversationId: string; cwd?: string; tools: readonly string[] }
  | { kind: "step_update"; step: AgyStepUpdate }
  | { kind: "result"; result: AgyResult }
  /** A kind this plugin does not know. */
  | { kind: "unknown"; event: string }
  /** A kind it knows, whose payload cannot be decoded. */
  | { kind: "malformed"; event: string; reason: string };

/** Values seen for `step_update.step_type`. Treated as data, never as a closed enum. */
export const STEP_AGENT_RESPONSE = "agent_response";
export const STEP_TOOL = "tool";
/**
 * The step agy reports once the `invoke_subagent` call it shares a `step_index` with has been
 * dispatched. It is the same step as the tool line, carrying `subagent_info` in place of
 * `tool_info`, and it arrives while the children are still running.
 */
export const STEP_SUBAGENT = "subagent";

export const STEP_STATE_DONE = "DONE";

/** agy reports an interrupted turn as a failed result carrying this exact error string. */
const INTERRUPTED_ERROR = "interrupted";

/**
 * The structured line agy 1.2.6+ documents as `AGY_ERROR: {...}` on stderr for a turn that ends on
 * an agent or model API failure (its changelog ties that line to headless `-p`/`--prompt` mode and
 * exit code 3). No capture in this repo produced one: a stream-json run with an invalid model, a
 * failed sign-in, a dead proxy, a 503 and an oversized prompt all reported the failure through a
 * plain `error:` line plus a failed result (fixtures/05-error.*, fixtures/05-unavailable.*).
 * The decoder is therefore best-effort: every field is optional and `raw` keeps the JSON exactly
 * as printed, so an unknown field still reaches `ProviderError.diagnostic` instead of being lost.
 */
export interface AgyErrorReport {
  /** Canonical status, e.g. `UNAVAILABLE`. */
  status?: string;
  /** One-line human summary. */
  short_error?: string;
  retryable?: boolean;
  raw: string;
}

const AGY_ERROR_PREFIX = "AGY_ERROR:";

/** Parse one stderr line into an AGY_ERROR report, or null when the line is not one. */
export function parseAgyErrorLine(line: string): AgyErrorReport | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(AGY_ERROR_PREFIX)) return null;

  const raw = trimmed.slice(AGY_ERROR_PREFIX.length).trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;

  const record = decoded as Record<string, unknown>;
  const text = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  return {
    status: text("status"),
    short_error: text("short_error"),
    ...(record.retryable === true ? { retryable: true } : {}),
    raw,
  };
}

/**
 * Parse one line of agy stdout. Returns null for blank lines, decorated output, and anything
 * that is not a well-formed event, so callers can simply skip the line.
 */
export function parseAgyLine(raw: string): AgyEvent | null {
  const line = raw.trim();
  if (line.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;

  const envelope = decoded as Record<string, unknown>;
  const name = envelope.event;
  if (typeof name !== "string") return null;

  if (name === "init") {
    const parsed = initSchema.safeParse(envelope);
    if (!parsed.success) return malformed(name, parsed.error);
    return {
      kind: "init",
      conversationId: parsed.data.conversation_id,
      cwd: parsed.data.init?.cwd,
      tools: parsed.data.init?.tools ?? [],
    };
  }

  if (name === "step_update") {
    const parsed = stepUpdateSchema.safeParse(envelope.step_update);
    if (!parsed.success) return malformed(name, parsed.error);
    return { kind: "step_update", step: parsed.data };
  }

  if (name === "result") {
    const parsed = resultSchema.safeParse(envelope.result);
    if (!parsed.success) return malformed(name, parsed.error);
    return { kind: "result", result: parsed.data };
  }

  return { kind: "unknown", event: name };
}

function malformed(event: string, error: z.ZodError): AgyEvent {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return { kind: "malformed", event, reason: `${where}${issue?.message ?? "unusable payload"}` };
}

/** One user turn, as written to agy stdin. */
export function encodeUserTurn(text: string): string {
  return (
    JSON.stringify({
      event: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n"
  );
}

export function isInterrupted(result: AgyResult): boolean {
  return result.status !== "SUCCESS" && result.error === INTERRUPTED_ERROR;
}
