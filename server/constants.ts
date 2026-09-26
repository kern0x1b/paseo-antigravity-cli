/**
 * Fixed values of the provider: its id, limits, the plan-mode wording, and the capabilities it
 * offers.
 */

export const PROVIDER_ID = "antigravity-cli";

export const STDERR_TAIL = 20;

/** Whole files remembered per session for diffing, newest last. */
export const OBSERVED_LIMIT = 32;

export const PLAN_MODE_ID = "plan";

/** The mode an approved plan is implemented in. */
export const IMPLEMENT_MODE_ID = "accept-edits";

/**
 * `--mode plan` changes nothing in a headless run: agy 1.1.28+ approves its own plan review when
 * no one can answer it, and a plan-mode run on agy 1.2.10 edited files straight away, with and
 * without --dangerously-skip-permissions (probed 2026-09-24). So plan mode is the plugin's to
 * enforce: every plan-mode turn carries this preamble, and its answer is offered as a plan.
 */
export const PLAN_MODE_PREAMBLE = `<plan_mode>
Plan mode is on. Do not create, edit, move or delete any file, and do not run commands that change anything: no installs, builds that write output, git commits, servers or other side effects. Read-only investigation — reading files, searching, and read-only commands — is allowed.
End your turn with a concrete implementation plan for the user to approve: the files to change, what changes in each, and how the result will be verified. Do not implement the plan; the user will approve it first.
</plan_mode>`;

/** What the plugin sends once the user approves a plan. */
export const IMPLEMENT_PLAN_TEXT = "The plan is approved. Implement it now.";

/**
 * A transient Antigravity outage. Captured verbatim from a real one as
 * `UNAVAILABLE (code 503): The service is currently unavailable.` in the failed result's `error`
 * (fixtures/05-unavailable.ndjson). The check is deliberately narrow: widening it would label a
 * permanent failure such as `model does-not-exist is not recognized` as worth retrying.
 */
export const UNAVAILABLE_PATTERN = /\bUNAVAILABLE\b|\(code 503\)/;

/**
 * `prompt.steer` is deliberately absent: a line written to agy stdin while a turn is running is
 * queued into a following turn rather than applied to the running one, so Paseo replaces the
 * active turn instead. agy resolves tool approvals internally and cannot surface them over this
 * protocol, so the only permission this provider ever requests is the plugin's own plan approval.
 *
 * `prompt.command` is supported by relaunching: a command turn runs on a CLI launched without
 * `--disable-slash-commands`, and the next plain turn relaunches with it again (see the launch
 * profile), because that flag also decides whether plain text starting with `/` expands.
 *
 * `permission.tool_policy` is accepted because `session.open` is rejected outright when the
 * config carries a `toolPolicy` and the capability is missing. Preapproved MCP tools cannot be
 * forwarded to agy, which reads its own rules from settings.json; that is covered by the MCP
 * notice emitted on session open.
 */
export const CAPABILITIES = [
  "prompt.message",
  // A slash command reaches the CLI as `/<name> <arguments>` on a process launched for it.
  "prompt.command",
  // Images cannot go over the stream (agy rejects image blocks), so they are written to the
  // plugin's attachments folder and referenced by path in the text.
  "prompt.image",
  // `--json-schema` makes agy decode the answer against a schema; the turn's last assistant row
  // then holds that JSON (see the SUCCESS branch of `handleResult`).
  "prompt.output_schema",
  "session.configure",
  // Antigravity's own conversation index is readable, which is what makes import possible.
  "session.list",
  "session.persistence",
  // Antigravity has no archive of its own, so archiving hides a conversation from the list offered
  // for import (see `archive.ts`).
  "session.archive",
  "session.unarchive",
  // A subagent run is followed through the transcript agy writes for its own conversation, and is
  // published as a child session under the invoke_subagent row that spawned it.
  "session.subsession",
  // A plan-mode turn ends with a plan the user approves or dismisses (`offerPlan`).
  "permission",
  "permission.tool_policy",
] as const;

/** The tool whose children this plugin follows. */
export const INVOKE_SUBAGENT = "invoke_subagent";

/** A child session's rows are addressed to `<parent session id>:subagent:<child conversation>`. */
export const CHILD_SESSION_MARKER = ":subagent:";

/** The child's prompt is a description, not a row: enough of it to say what the child is doing. */
export const DESCRIPTION_LIMIT = 200;
