#!/usr/bin/env node
/**
 * Stands in for the Antigravity CLI in tests. It speaks the captured stream-json protocol
 * (see server/protocol.ts and fixtures/) and can be told which scenario to play through env vars.
 *
 *   FAKE_ARGV_FILE       when set, the received argv is written here so tests can assert flags
 *   FAKE_SCENARIO        text (default) | tool | interrupt | error | fail
 *   FAKE_CONVERSATION_ID conversation id reported by the init event
 *   FAKE_MODELS_OK       "1" makes `agy models` succeed, anything else makes it fail
 */
import { appendFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const argv = process.argv.slice(2);

if (process.env.FAKE_ARGV_FILE) {
  writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(argv), "utf8");
}

if (argv[0] === "models") {
  if (process.env.FAKE_MODELS_OK === "1") {
    process.stdout.write("Fetching available models...\n");
    process.stdout.write("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
    process.stdout.write("fake-model-x\tFake Model X\n");
    process.exit(0);
  }
  process.stderr.write("error: could not list models\n");
  process.exit(1);
}

const conversationId = process.env.FAKE_CONVERSATION_ID ?? "11111111-2222-3333-4444-555555555555";
const scenario = process.env.FAKE_SCENARIO ?? "text";

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const usage = {
  input_tokens: 15466,
  output_tokens: 27,
  thinking_tokens: 25,
  cache_read_tokens: 0,
  total_tokens: 15518,
};

let step = 0;
let turns = 0;

// Registered before any output is written, so a consumer that has seen `init` can rely on
// SIGINT being handled rather than terminating the process by default.
if (scenario === "interrupt") {
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

send({
  event: "init",
  conversation_id: conversationId,
  init: {
    cwd: process.cwd(),
    tools: ["run_command", "view_file"],
    permission_mode: "always-proceed",
  },
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
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
    process.stderr.write("error: invalid model selection: model nope is not recognized\n");
    process.exit(1);
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

  if (scenario === "error") {
    send({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "ERROR",
        response: "",
        error: "Eligibility check failed: the service is currently unavailable.",
        duration_seconds: 0,
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
      usage,
    },
  });
  send({
    event: "result",
    result: {
      conversation_id: conversationId,
      status: "SUCCESS",
      response: `${response}\n`,
      duration_seconds: 0.2,
      num_turns: turns,
      usage,
    },
  });
});
