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
 * Everything is marked optional and unknown kinds are dropped rather than thrown, because
 * agy ships updates frequently and a schema drift must not take the provider down.
 */

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  thinking_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const initSchema = z.object({
  conversation_id: z.string(),
  init: z
    .object({
      cwd: z.string().optional(),
      tools: z.array(z.string()).optional(),
      permission_mode: z.string().optional(),
    })
    .optional(),
});

const toolInfoSchema = z.object({
  name: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
});

const stepUpdateSchema = z.object({
  conversation_id: z.string().optional(),
  step_index: z.number(),
  state: z.string(),
  step_type: z.string(),
  /** Incremental text chunk, not a snapshot. Absent on non-text steps. */
  text_delta: z.string().optional(),
  tool_name: z.string().optional(),
  tool_info: toolInfoSchema.optional(),
  duration_seconds: z.number().optional(),
  usage: usageSchema.optional(),
});

const resultSchema = z.object({
  conversation_id: z.string().optional(),
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  duration_seconds: z.number().optional(),
  num_turns: z.number().optional(),
  usage: usageSchema.optional(),
});

export type AgyUsage = z.infer<typeof usageSchema>;
export type AgyStepUpdate = z.infer<typeof stepUpdateSchema>;
export type AgyToolInfo = z.infer<typeof toolInfoSchema>;
export type AgyResult = z.infer<typeof resultSchema>;

export type AgyEvent =
  | { kind: "init"; conversationId: string; cwd?: string; tools: readonly string[] }
  | { kind: "step_update"; step: AgyStepUpdate }
  | { kind: "result"; result: AgyResult }
  | { kind: "unknown"; event: string };

/** Values seen for `step_update.step_type`. Treated as data, never as a closed enum. */
export const STEP_USER_INPUT = "user_input";
export const STEP_AGENT_RESPONSE = "agent_response";
export const STEP_TOOL = "tool";
export const STEP_SYSTEM_MESSAGE = "system_message";

export const STEP_STATE_ACTIVE = "ACTIVE";
export const STEP_STATE_DONE = "DONE";

/** agy reports an interrupted turn as a failed result carrying this exact error string. */
export const INTERRUPTED_ERROR = "interrupted";

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
    if (!parsed.success) return { kind: "unknown", event: name };
    return {
      kind: "init",
      conversationId: parsed.data.conversation_id,
      cwd: parsed.data.init?.cwd,
      tools: parsed.data.init?.tools ?? [],
    };
  }

  if (name === "step_update") {
    const parsed = stepUpdateSchema.safeParse(envelope.step_update);
    if (!parsed.success) return { kind: "unknown", event: name };
    return { kind: "step_update", step: parsed.data };
  }

  if (name === "result") {
    const parsed = resultSchema.safeParse(envelope.result);
    if (!parsed.success) return { kind: "unknown", event: name };
    return { kind: "result", result: parsed.data };
  }

  return { kind: "unknown", event: name };
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
