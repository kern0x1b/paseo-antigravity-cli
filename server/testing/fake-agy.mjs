#!/usr/bin/env node
/**
 * Stands in for the Antigravity CLI in tests. It speaks the captured stream-json protocol
 * (see server/protocol.ts and fixtures/) and can be told which scenario to play through env vars.
 *
 *   FAKE_ARGV_FILE       when set, the received argv is written here so tests can assert flags
 *   FAKE_ARGV_LOG        when set, every launch appends its argv here, one JSON array per line
 *   FAKE_SCENARIO        text (default) | tool | edit | edit-applied | queued | interrupt | error
 *                        | fail | tool-hang | stdin-closed | schema | schema-invalid
 *   FAKE_SCHEMA_OUTPUT   JSON the `schema` scenario returns as structured_output
 *   FAKE_SCHEMA_GATE     file the `schema` scenario waits for before answering, so a test can act
 *                        while that turn is still running
 *   FAKE_SCHEMA_ERROR    text of a failed result the `schema` scenario reports instead of SUCCESS
 *   FAKE_SCHEMA_STICKY   "1" makes even a flagless process report that structured_output, which
 *                        is what agy does on a conversation that has used a schema
 *   FAKE_EDIT_FILE       file an `edit` turn rewrites (default <cwd>/hello.txt)
 *   FAKE_EDIT_TOOL       tool an `edit` turn reports (default replace_file_content)
 *   FAKE_EDIT_AFTER      content the edit writes (default "bye world\n")
 *   FAKE_EDIT_GATE       file the rewrite waits for, so the test decides when the edit lands
 *   FAKE_EDIT_SKIP_WRITE "1" reports the edit without writing anything
 *   FAKE_CONVERSATION_ID conversation id reported by the init event
 *   FAKE_STDERR_LINE     diagnostic written by the `fail` scenario
 *   FAKE_RESULT_ERROR    text of the failed result in the `error` scenario and in `tool-hang`
 *                        with FAKE_TOOL_END=error
 *   FAKE_TOOL_END        how `tool-hang` ends the turn: interrupt (default) | error | die
 *   FAKE_MODELS_OK       "1" makes `agy models` succeed, anything else makes it fail
 *   FAKE_MODELS_LOG      when set, every `agy models` run appends a line here
 *   FAKE_RESULT_INPUT_TOKENS  input_tokens of the terminal result (default 15466)
 *   FAKE_STEP_INPUT_TOKENS    input_tokens of an agent_response step (default: the result's)
 */
import { appendFileSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import readline from "node:readline";
import { PassThrough } from "node:stream";

const argv = process.argv.slice(2);

if (process.env.FAKE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv), "utf8");
}

// Every launch, in order: a restart test needs to see the flags of each process, not just the last.
if (process.env.FAKE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`, "utf8");
}

/** The schema file `--json-schema` points at, when this process was launched with one. */
const schemaIndex = argv.indexOf("--json-schema");
const schemaPath = schemaIndex === -1 ? null : argv[schemaIndex + 1];

if (argv[0] === "models") {
  if (process.env.FAKE_MODELS_LOG) {
    appendFileSync(process.env.FAKE_MODELS_LOG, "models\n", "utf8");
  }
  if (process.env.FAKE_MODELS_OK === "1") {
    // Copied verbatim from `agy models` on Antigravity CLI 1.2.9, plus one model the real CLI
    // does not have so a test can tell a discovered row from a bundled one.
    process.stdout.write("Fetching available models...\n");
    process.stdout.write("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
    process.stdout.write("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n");
    process.stdout.write("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n");
    process.stdout.write("gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n");
    process.stdout.write("gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n");
    process.stdout.write("gemini-3.7-flash-low\tGemini 3.7 Flash (Low)\n");
    process.stdout.write("gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n");
    process.stdout.write("gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\n");
    process.stdout.write("gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n");
    process.stdout.write("gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n");
    process.stdout.write("gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n");
    process.stdout.write("claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n");
    process.stdout.write("claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n");
    process.stdout.write("gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n");
    process.stdout.write("fake-model-x\tFake Model X\n");
    process.exit(0);
  }
  process.stderr.write("error: could not list models\n");
  process.exit(1);
}

const conversationId = process.env.FAKE_CONVERSATION_ID ?? "11111111-2222-3333-4444-555555555555";
const scenario = process.env.FAKE_SCENARIO ?? "text";

/** Mirrors a captured 503: agy fails the turn and quotes the service error to the user. */
const defaultResultError = "Eligibility check failed: the service is currently unavailable.";

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

/**
 * Sends a terminal result. Antigravity keeps a schema with the *conversation*: a process started
 * without `--json-schema` still reports that conversation's last structured_output, which is why
 * the knob applies to results the schema scenario did not build itself (probed 2026-09-23).
 */
const sendResult = (result) => {
  const sticky =
    process.env.FAKE_SCHEMA_STICKY === "1" && result.structured_output === undefined
      ? JSON.parse(process.env.FAKE_SCHEMA_OUTPUT ?? '{"color":"blue","count":8}')
      : undefined;
  send({ event: "result", result: sticky === undefined ? result : { ...result, structured_output: sticky } });
};

const usage = {
  input_tokens: Number(process.env.FAKE_RESULT_INPUT_TOKENS ?? 15466),
  output_tokens: 27,
  thinking_tokens: 25,
  cache_read_tokens: 0,
  total_tokens: 15518,
};

/**
 * The result totals every step of the turn, while a step reports what the model held in its
 * context window, which is why the two are configurable apart (captured: 31074 = 15388 + 15686).
 */
const stepUsage = {
  ...usage,
  input_tokens: Number(process.env.FAKE_STEP_INPUT_TOKENS ?? usage.input_tokens),
};

let step = 0;
let turns = 0;

/**
 * Holds a scenario until the test lets it continue. Polling a file is the only channel between a
 * test and this process; there is no timing guess and no sleep to speak of.
 */
async function waitForGate(variable = "FAKE_EDIT_GATE") {
  const gate = process.env[variable];
  if (!gate) return;
  const deadline = Date.now() + 10_000;
  while (!existsSync(gate) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// The queued scenario holds turn 1's answer until the second line arrives.
let heldAnswer = null;

const stepEvent = (stepIndex, state, stepType, extra = {}) => ({
  event: "step_update",
  step_update: {
    conversation_id: conversationId,
    step_index: stepIndex,
    state,
    step_type: stepType,
    ...extra,
  },
});

/** The `result` payload of a turn, as `sendResult` expects it. */
const turnResult = (numTurns, response, status = "SUCCESS", error) => ({
  conversation_id: conversationId,
  status,
  response,
  ...(error ? { error } : {}),
  num_turns: numTurns,
  usage,
});

/**
 * Turn 1 streams half an answer and then waits for the queued line before finishing, the order agy
 * uses when a prompt arrives while it is still running (see fixtures/04-queued-second-line.ndjson).
 */
function playQueued(text) {
  const response = `echo:${text}`;
  const middle = Math.max(1, Math.floor(response.length / 2));

  if (heldAnswer === null) {
    send(stepEvent(step, "DONE", "user_input"));
    step += 1;
    const textStep = step;
    step += 1;
    send(stepEvent(textStep, "ACTIVE", "agent_response", { text_delta: response.slice(0, middle) }));
    heldAnswer = { textStep, response, offset: middle };
    return;
  }

  const held = heldAnswer;
  heldAnswer = null;
  // The held turn's remaining text and its result both precede the queued turn.
  send(
    stepEvent(held.textStep, "DONE", "agent_response", {
      text_delta: `${held.response.slice(held.offset)}\n`,
      usage: stepUsage,
    }),
  );
  sendResult(turnResult(1, `${held.response}\n`));

  send(stepEvent(step, "DONE", "user_input"));
  step += 1;
  const textStep = step;
  step += 1;
  send(stepEvent(textStep, "ACTIVE", "agent_response", { text_delta: response.slice(0, middle) }));
  send(
    stepEvent(textStep, "DONE", "agent_response", {
      text_delta: `${response.slice(middle)}\n`,
      usage: stepUsage,
    }),
  );
  sendResult(turnResult(2, `${response}\n`));
}

// Registered before any output is written, so a consumer that has seen `init` can rely on
// SIGINT being handled rather than terminating the process by default.
const toolEnding = process.env.FAKE_TOOL_END ?? "interrupt";
if (scenario === "interrupt" || (scenario === "tool-hang" && toolEnding === "interrupt")) {
  // Captured behaviour: SIGINT prints `error: interrupted` on stderr, emits a failed result
  // carrying the same marker, then exits with code 1.
  process.on("SIGINT", () => {
    process.stderr.write("error: interrupted\n");
    // Exit from the write callback so the result is flushed; process.exit() would truncate it.
    process.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "ERROR",
          response: "",
          error: "interrupted",
          duration_seconds: 0,
          num_turns: turns,
          usage,
        },
      })}\n`,
      () => process.exit(1),
    );
  });
}

// A CLI whose stdin has already closed reads nothing more: `stdin-closed` closes the pipe before
// reporting init, so a turn written afterwards hits a dead pipe, and a listening socket keeps the
// process up.
const stdinGone = scenario === "stdin-closed";
if (stdinGone) {
  closeSync(0);
  createServer().listen(0);
}

// A CLI that rejects its `--json-schema` never starts a conversation: agy prints the reason and
// exits 1 with no stdout at all, which is why this scenario emits no init event.
const schemaRejected = scenario === "schema-invalid";

if (!schemaRejected) {
  send({
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: process.cwd(),
      tools: ["run_command", "view_file"],
      permission_mode: "always-proceed",
    },
  });
}

const input = stdinGone ? new PassThrough() : process.stdin;
readline.createInterface({ input }).on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.event !== "user") return;

  const content = message.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part.text ?? "").join("")
        : "";

  if (process.env.FAKE_PROMPT_FILE) {
    appendFileSync(process.env.FAKE_PROMPT_FILE, `${JSON.stringify(text)}\n`, "utf8");
  }

  if (scenario === "fail") {
    // Mirrors a rejected --model: agy writes to stderr and exits without a result event.
    process.stderr.write(
      `${process.env.FAKE_STDERR_LINE ?? "error: invalid model selection: model nope is not recognized"}\n`,
    );
    process.exit(1);
  }

  if (schemaRejected) {
    // agy 1.2.9 exits 1 with no stdout when the schema file cannot be read, so the turn must be
    // failed from the exit path instead of waiting for an answer that is never coming.
    process.stderr.write("Error: invalid --json-schema: failed to parse schema file\n");
    process.exit(1);
  }

  if (scenario === "queued") {
    playQueued(text);
    return;
  }

  turns += 1;
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "DONE",
      step_type: "user_input",
    },
  });
  step += 1;

  // Stay silent so the turn stays running until the test interrupts it.
  if (scenario === "interrupt") return;

  if (scenario === "tool-hang") {
    // The tool stays ACTIVE: the turn only ends when the test interrupts it, agy reports an
    // error, or the process dies.
    const toolStep = step;
    step += 1;
    send(
      stepEvent(toolStep, "ACTIVE", "tool", {
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "sleep 30" } },
      }),
    );
    if (toolEnding === "error") {
      sendResult(turnResult(turns, "", "ERROR", process.env.FAKE_RESULT_ERROR ?? defaultResultError));
    } else if (toolEnding === "die") {
      process.stderr.write("error: the Antigravity service closed the connection\n");
      process.exit(1);
    }
    return;
  }

  if (scenario === "error") {
    sendResult({
      conversation_id: conversationId,
      status: "ERROR",
      response: "",
      error: process.env.FAKE_RESULT_ERROR ?? defaultResultError,
      duration_seconds: 0,
      num_turns: turns,
      usage,
    });
    return;
  }

  if (scenario === "schema" && schemaPath !== null) {
    // A structured turn as captured in fixtures/10-schema.ndjson: the *streamed* text is the answer
    // with the CLI's toolAction/toolSummary keys added, `response` repeats it, and the decoded
    // answer is in `structured_output`. Reading the schema file also proves the provider wrote it.
    const answer = JSON.parse(process.env.FAKE_SCHEMA_OUTPUT ?? '{"color":"blue","count":8}');
    let schema;
    try {
      schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    } catch (error) {
      sendResult(turnResult(turns, "", "ERROR", `invalid --json-schema: ${error.message}`));
      return;
    }
    const streamed = JSON.stringify({
      ...answer,
      toolAction: "Finishing task",
      toolSummary: "Task completion",
    });

    send(stepEvent(step, "ACTIVE", "agent_response", { text_delta: streamed }));
    // The gate holds the answer, so a test can act while the schema turn is still running.
    await waitForGate("FAKE_SCHEMA_GATE");
    send(stepEvent(step, "DONE", "agent_response", { text_delta: "\n", usage: stepUsage }));
    step += 1;

    if (process.env.FAKE_SCHEMA_ERROR) {
      sendResult(turnResult(turns, "", "ERROR", process.env.FAKE_SCHEMA_ERROR));
      return;
    }
    send({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        response: `${streamed}\n`,
        structured_output: answer,
        json_schema: schema,
        duration_seconds: 0.2,
        num_turns: turns,
        usage,
      },
    });
    return;
  }

  const response = `echo:${text}`;
  const middle = Math.max(1, Math.floor(response.length / 2));
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: response.slice(0, middle),
    },
  });
  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "ACTIVE",
      step_type: "agent_response",
      text_delta: response.slice(middle),
    },
  });

  if (scenario === "edit" || scenario === "edit-applied") {
    // The captured shape of an edit: the stream names the file and nothing else, so a consumer
    // can only describe the change by comparing the file before and after the call.
    const file = process.env.FAKE_EDIT_FILE ?? `${process.cwd()}/hello.txt`;
    const toolName = process.env.FAKE_EDIT_TOOL ?? "replace_file_content";
    const toolInfo = { name: toolName, parameters: { TargetFile: file } };

    if (scenario === "edit-applied") {
      // agy applies the edit before the step is deliverable, so a consumer only ever sees the
      // file as a `view_file` step showed it. The gate opens once that step has been seen.
      send(
        stepEvent(step, "ACTIVE", "tool", {
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: file } },
        }),
      );
      await waitForGate();
      send(
        stepEvent(step, "DONE", "tool", {
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: file } },
          output: "1 line, 12 bytes",
          duration_seconds: 0.01,
        }),
      );
      step += 1;
      if (process.env.FAKE_EDIT_SKIP_WRITE !== "1") {
        writeFileSync(file, process.env.FAKE_EDIT_AFTER ?? "bye world\n");
      }
      send(stepEvent(step, "ACTIVE", "tool", { tool_name: toolName, tool_info: toolInfo }));
      send(
        stepEvent(step, "DONE", "tool", {
          tool_name: toolName,
          tool_info: toolInfo,
          duration_seconds: 0.02,
        }),
      );
      step += 1;
    } else {
      const toolStep = step;
      step += 1;
      send(stepEvent(toolStep, "ACTIVE", "tool", { tool_name: toolName, tool_info: toolInfo }));
      await waitForGate();
      if (process.env.FAKE_EDIT_SKIP_WRITE !== "1") {
        writeFileSync(file, process.env.FAKE_EDIT_AFTER ?? "bye world\n");
      }
      send(
        stepEvent(toolStep, "DONE", "tool", {
          tool_name: toolName,
          tool_info: toolInfo,
          duration_seconds: 0.02,
        }),
      );
    }
  }

  if (scenario === "tool") {
    step += 1;
    const toolInfo = { name: "run_command", parameters: { CommandLine: "ls -la" } };
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: step,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: toolInfo,
      },
    });
    send({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        step_index: step,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { ...toolInfo, output: "hello.txt" },
        duration_seconds: 0.05,
      },
    });
  }

  send({
    event: "step_update",
    step_update: {
      conversation_id: conversationId,
      step_index: step,
      state: "DONE",
      step_type: "agent_response",
      text_delta: "\n",
      duration_seconds: 0.1,
      usage: stepUsage,
    },
  });
  sendResult({
    conversation_id: conversationId,
    status: "SUCCESS",
    response: `${response}\n`,
    duration_seconds: 0.2,
    num_turns: turns,
    usage,
  });
});
