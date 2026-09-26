# Antigravity CLI provider for Paseo

Runs Google's official Antigravity CLI (`agy`) as a Paseo provider: Paseo owns the session, the
CLI does the work, and every turn, tool call, and message is rendered from the CLI's `stream-json`
protocol. Nothing about Antigravity is reimplemented — this plugin spawns the `agy` binary that is
already installed and signed in on your machine.

- Provider id: `antigravity-cli`
- Requires: Paseo ≥ 0.9.1 (provider protocol version 1), Node 24 for the plugin process, and
  Antigravity CLI 1.2.9 for the behaviour described below.

## Install

From npm (Paseo 0.9):

```
paseo plugin install npm:paseo-plugin-antigravity-cli
```

Or from GitHub:

```
paseo plugin install github:kern0x1b/paseo-antigravity-cli
```

You can also paste either source into **Settings → Plugins → Plugin source**. Check it with
`paseo plugin ls`; `antigravity-cli` should be `running`.

Antigravity must already work on its own: `agy --version` should print, and `agy` should be signed
in. Then pick **Antigravity** as the provider when you start a new agent.

### How this differs from `agy-provider`

[`agy-provider`](https://paseo.cafe/plugins/agy-provider) adapts Google's Antigravity ACP server
through Paseo's ACP shim. This plugin drives the `agy` CLI directly over its documented
`--input-format stream-json` / `--output-format stream-json` mode, so it needs no extra server
install. On top of plain turns it adds edit diffs rebuilt from file snapshots, structured output
through `--json-schema`, image input, import of existing agy conversations, slash commands and
skills, and opt-in sharing of Paseo's MCP tools.

### Which `agy` gets launched

The first one that resolves, in this order:

1. `providerOptions.agyPath` — a per-session absolute path to the binary.
2. `PASEO_ANTIGRAVITY_BIN` — an environment variable for the daemon's environment.
3. `~/.local/bin/agy` — checked explicitly because a daemon started by a GUI app often does not
   inherit that directory on `PATH`.
4. `agy` — resolved from `PATH`.

## What the plugin supports

| Capability | Behaviour |
|---|---|
| `prompt.message` | One `agy` process per session; each prompt is one NDJSON turn on its stdin and exactly one `result` back. A prompt sent while a turn runs is queued by the CLI and becomes the next turn. |
| `prompt.command` | Slash commands, through the composer's command picker. A command turn runs on a CLI launched *without* `--disable-slash-commands` and sends `/<name> <arguments>` as the first token of the turn, which is what makes the CLI expand it; the next plain turn relaunches with the flag again (see below). |
| `prompt.image` | Images cannot go over `stream-json` (`stream input content block type "image" is not supported (only "text")`), so each image part is written to the plugin's attachments folder and the prompt names its absolute path with `view it with view_file`. The folder is passed as an extra `--add-dir` and deleted on `session.close`. Nothing is written into your workspace. |
| `prompt.output_schema` | A prompt with an `outputSchema` is served by a CLI launched with `--json-schema <file> --conversation <id>`; the turn's last assistant message is `JSON.stringify(result.structured_output)`. The flag is launch-time only, so the CLI is relaunched without it before the next plain turn, and a schema prompt is refused with `code: "busy"` while another turn is pending. |
| `session.configure` | Model, reasoning tier, mode, and settings. All of them are launch flags, so a change restarts the CLI on the next turn, resuming the same conversation with `--conversation <id>`. |
| `session.list` | Imports existing Antigravity conversations by reading `~/.gemini/antigravity-cli/conversation_summaries.db` read-only. Filter by workspace, text, and limit; subagent runs are excluded. |
| `session.persistence` | The conversation id agy reports is persisted, so reopening an agent resumes the same Antigravity conversation. |
| `session.subsession` | Each subagent an `invoke_subagent` call starts is shown as a child session of the agent that spawned it, linked to its row, and follows the child's own transcript live (see [Subagents](#subagents)). |
| `permission` | Used only for plan approval: a plan-mode turn ends with an *Implement this plan?* prompt (see [Plan mode](#plan-mode)). agy's own tool approvals cannot be surfaced. |
| `permission.tool_policy` | Accepted (Paseo rejects a session carrying a tool policy otherwise), but preapproved MCP tools cannot be forwarded: agy reads its own rules from `settings.json`. |

Models come from `agy models` (cached for 10 minutes against the resolved binary's path and
mtime; `force` rediscovers). Reasoning tiers are encoded in the model id itself
(`gemini-3.8-flash-high`), so the composer shows one model per family with High/Medium/Low and maps
the choice back onto the slug — `--effort` is never passed, because the CLI rejects the pair.

Modes: *Default* (review file writes before they run), *Accept edits*, *Plan*.

Tool rows are mapped from the CLI's own step parameters: shell commands, file reads and writes,
edits (with a unified diff), `grep_search`/`find_by_name`/`list_dir`, `search_web`,
`read_url_content`, `define_subagent`, and `call_mcp_tool` (shown as `server/tool`). Subagents
get their own rows, below.

### Plan mode

`agy --mode plan` does not stop a headless run from editing: agy 1.1.28+ approves its own plan
review when nobody can answer it, and on CLI 1.2.10 a `--mode plan` run edited files straight away,
with and without `--dangerously-skip-permissions` (probed 2026-09-24). The plugin therefore enforces
plan mode itself:

- every plan-mode turn is prefixed with a `<plan_mode>` block telling the model to investigate
  read-only and end with an implementation plan instead of implementing it;
- when the turn completes, its last answer is offered as a plan (`kind: "plan"` permission) with
  **Implement** and **Keep planning**. *Implement* switches the session to *Accept edits* and sends
  `The plan is approved. Implement it now.`; *Keep planning*, or simply sending another message,
  withdraws the prompt and stays in plan mode.

This is an instruction, not a sandbox: agy has no headless flag that denies edits, so a model that
ignores the instruction can still write files.

### Background commands

When the model starts a long-running command in the background (tests, a build, a dev server), agy
keeps that tool `ACTIVE` on the stream until the command exits and holds back every later step and
the turn's `result` behind it — the conversation itself carries on in its own transcript (CLI
1.2.10). A tool still running after 5 s therefore makes the plugin read the conversation's own
transcript (`~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`)
and publish the steps the stream is holding.

The turn completes at the model's answer, as it does for any other provider; a message you send
next is served straight away. If the command is still running then, a notice says so, and the CLI
holding it is left running so a server stays up. When a command ends (or a timer fires), agy wakes
the model, and what it does then is published as a turn of its own — one Paseo shows as started by
the agent rather than by you — from the model's first step to its final answer. Stopping the agent
cancels that turn. A message you send while it runs waits for it, since the CLI cannot take another
turn; otherwise the CLI cannot take another turn either (a line written to it would queue behind the
command), so your next message stops it — and the command with it — and resumes the conversation in
a fresh CLI.

What counts as a task is read from the fields agy structures in the transcript, not from its
wording: a `GENERIC` step that stays `RUNNING` and names a `…/task-N` id starts one, and a
`SYSTEM_MESSAGE` whose `[Message]` header names that id as its `sender` reports on it (finished,
canceled, a timer firing, or output that stabilized).

## Subagents

When the model delegates with `invoke_subagent`, agy starts each subagent as its own conversation
in the background and keeps the parent turn open until their reports arrive. The plugin shows that
in two layers:

1. **A subagent row in the parent timeline**, built only from the parent's stream: one row per
   subagent (one call may start several), with its type, role, and the prompt it was given. The
   row stays *running* while the subagent works, and ends *completed* when the subagent finishes or
   the turn succeeds, *canceled* when the turn is interrupted, and *failed* when the turn fails.
2. **A child session per subagent.** agy names each subagent's transcript
   (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, handed out as
   the step's `log_uri`). The plugin follows that file while the subagent runs and shows it as a
   Paseo child session linked to the row: the subagent's prompt, each tool call with its result,
   and its final answer. The row's text becomes the report the subagent sent back to the parent,
   and the row lists the subagent's tool calls. The child's rows are stored like the parent's, so
   reopening the agent with history restores its children too.

The transcript file is agy-internal and undocumented, so the child session is best-effort: a
missing or unreadable transcript, or one in a shape the plugin does not recognise, leaves the row
from step 1 in place (the parent turn is never affected), and lines of an unknown kind are skipped.
A subagent counts as finished when its transcript ends on an answer with no further tool call; the
parent's own "report arrived" step is not used, because it arrives well after the transcript's last
line and does not say which subagent it belongs to. The plugin stops following a transcript when
the subagent finishes, when the session or the plugin closes, when the parent turn is interrupted or
fails, when the file never shows up within a minute, or after ten minutes without a new line.

## Slash commands

The composer's command picker lists the commands this plugin has verified the CLI expands in
`stream-json` mode (each one probed against CLI 1.2.9 with `--log-file`, which is the only place
`Print mode: expanded slash command "<name>"` is written — stderr never shows it):

| Command | Source |
|---|---|
| `/plan`, `/goal`, `/grill-me`, `/teamwork-preview`, `/learn`, `/schedule`, `/boost`, `/browser` | The CLI's own workflows (`(system)` in the log). `/learn` writes the behaviour into the workspace's `GEMINI.md`; `/schedule` sets up a recurring run; `/boost` runs the task with deep thinking, multiple perspectives and rigorous verification (it answers `Routine: Solo` when it keeps the work to itself); `/browser` hands the task to the CLI's browser agent. |
| `/<name>` | A skill in this workspace's customization roots: `.agents/skills/<name>/SKILL.md`, and the same under `.agent/`, `_agents/`, `_agent/` (`(skill)` in the log). The name is the skill's own frontmatter `name`, not its directory. |
| `/<name>` | A skill installed for every workspace, in the CLI's own precedence order: `~/.gemini/antigravity-cli/skills/<name>/SKILL.md`, `~/.gemini/config/skills/<name>/SKILL.md`, then `~/.gemini/skills/<name>/SKILL.md`. All three expand (`(skill)` in the log), and each one outranks the CLI's built-in skills. |
| `<plugin>:<name>` | A skill of a plugin installed for the CLI, under `~/.gemini/config/plugins/<plugin>/skills/`. A plugin that keeps its one skill directly in `skills/` is addressed with a `..` placeholder — `/android-cli-plugin:..:android-cli` — because that is the name the CLI expands. |
| `<name>` | A skill the CLI ships itself, under `~/.gemini/antigravity-cli/builtin/skills/`. |
| `/<name>` | A skill in the shared installer's directory, `~/.agents/skills/<name>/SKILL.md`. The CLI never reads that directory, so the **plugin expands this one itself**: agy is sent the skill's own instructions as a plain message (never a slash name) and is given the skill's directory as an extra `--add-dir`, so the turn can read the scripts and templates the skill refers to. A name the CLI expands on its own, or a workspace skill, always wins over the copy here. |

Antigravity decides some built-ins per account, not per binary: `/boost` and `/teamwork-preview`
answer to the `boost_command_disabled` and `teamwork_preview_command_disabled` admin controls, and
`/compact`, `/review` and `/owl` exist in the binary but stayed inert for the account these probes
ran on (`enable-compact-slash-command`, `enable-review`, `enable-owl-slash-command`). A built-in
that is disabled for your account simply **does not expand**: agy treats the text as an ordinary
message and the model answers it, so choosing one of the commands above costs a normal turn rather
than failing it. `/boost` and `/browser` expanded on every probe on the same account as the six
before them, so they are listed; `/compact`, `/review` and `/owl` never expanded there, and a
plugin cannot tell whether any other account has them, so they stay out rather than send a name
that would silently be answered as text.

Commands the CLI answers itself (`/skills`, `/usage`, `/quota`, `/credits`, `/model`, `/effort`,
`/help`, `/config`, `/permissions`, `/hooks`, `/agents`, `/changelog`, …) are deliberately absent:
in a `stream-json` turn each one ends the turn with `ERROR` and exit 2 — `/skills` says so itself
(`/skills is answered by the CLI itself and is unavailable with --input-format stream-json; run it
as its own --print /skills invocation`), and `/btw` and `/tasks` report "not available in print
mode" — so offering one would kill the turn instead of running it. They remain available inside the
CLI's own TUI, or through a separate `--print <command>` invocation.

A command is a *turn*, so it obeys the relaunch rules: `--disable-slash-commands` is left off for
that turn's process and put back for the next plain turn, on the same conversation. That flag is
also what keeps a plain message starting with `/` from being expanded, so while a command turn is
running both a further command and a plain prompt are refused with `code: "busy"` rather than
queued into a process that would serve them wrongly.

A plugin-expanded skill (`~/.agents/skills`, above) is the mirror image: `--disable-slash-commands`
stays on, because the turn is an ordinary message, but the skill's directory joins the launch flags
for that turn alone, so it is its own launch too — the next plain turn relaunches without it. While
such a turn runs, a second command and a plain prompt are refused with `code: "busy"` for the same
reason: the CLI cannot be replaced until the turn it owes has finished.

## What it cannot do, and why

- **Steering** (`prompt.steer`): a line written to agy's stdin while a turn is running is *queued
  into a following turn*, not applied to the running one. There is no way to steer, so Paseo
  replaces the active turn instead of offering it.
- **Tool permission prompts**: agy resolves tool approval internally through its own
  `toolPermission` setting and cannot surface a request over `stream-json`. Choose the approval
  behaviour in the session settings instead. (`permission` is negotiated only for plan approval.)
- **Rewind** (`session.revert.*`): Antigravity's `/rewind` is interactive-only; nothing in
  `stream-json` exposes it.
- **Shared-installer skills are expanded by the plugin, not the CLI.** `~/.agents/skills/<name>/SKILL.md`
  — the directory other agent CLIs install skills into — is never read by `agy` (probed on CLI 1.2.9:
  a probe skill there was absent from `agy --print /skills`, and a skill that does exist there,
  `/paseo-help`, reached the model as plain text). Paseo therefore offers those names and this plugin
  expands them itself: the turn is sent the `SKILL.md` body, frontmatter stripped, capped at 64 KiB
  (a larger file fails that prompt with `code: "skill_too_large"`, and one that is gone by the time
  the command runs fails with `code: "skill_unavailable"`), followed by the skill's directory and your
  request. Because it is one message and not a CLI command, nothing in it is expanded as a slash name.
  A skill you want the CLI itself to expand belongs under one of the CLI's own roots above.

## Session settings

- **Tool approval** … default *Use Antigravity setting*, no flag; *Skip all permissions* passes
  `--dangerously-skip-permissions`.
- **Sandbox** — an Off/On select. *On* passes `--sandbox`.
- **Share Paseo tools with Antigravity** — an Off/On select, *Off* by default (below).

The booleans are selects rather than toggles because Paseo draws a plugin toggle as an icon-only
button with no on/off state, so its value is invisible; a select shows the current value as a pill.
Settings saved while these were toggles (`true`/`false`) read as *On*/*Off*.

## providerOptions

| Option | Effect |
|---|---|
| `agyPath` | Absolute path to the CLI binary for this session. |
| `extraArgs` | Extra argv appended after the plugin's own flags, for CLI options the plugin does not model. |
| `addDirs` | Absolute paths to existing directories, each passed as its own `--add-dir`. Anything else is dropped with a warning notice. |

## Sharing Paseo's MCP servers (opt-in)

Antigravity reads MCP servers from `~/.gemini/config/mcp_config.json` and from
`<dir>/.agents/mcp_config.json` for each directory it was given. With **Share Paseo tools with
Antigravity** on, the plugin writes Paseo's `mcpServers` into `<cwd>/.agents/mcp_config.json` as
`paseo-<name>` entries before the CLI starts; the model reaches them through agy's `call_mcp_tool`.

- Off by default. Nothing is written until you turn it on.
- Those entries hold whatever credentials the servers use (HTTP headers, or environment variables
  for stdio servers). When the session's workspace is inside a git work tree the plugin adds the
  file's path, relative to the repository root, to that repository's own `info/exclude` (the local
  one under `.git`, which linked worktrees share). That file is never committed and is not shared
  with anyone else, and `git add .` treats its lines exactly like `.gitignore` lines — so the
  config, and the token in it, cannot be committed by accident. Nothing else is written there: the
  plugin never edits `.gitignore`, and it removes its two lines again when the last Paseo session
  in that workspace closes. A notice naming the file is shown whenever it is written.
- Outside a git work tree, or when `git` is not installed, nothing is excluded: sharing still
  works, but keep `.agents/mcp_config.json` out of your commits yourself (a `.git/info/exclude`
  line in whichever repository holds the workspace, an entry in a global `core.excludesFile`, or
  `.gitignore` if you accept committing that entry).
- Ownership is tracked in a ledger; on the last `session.close` for that directory the plugin
  removes only its own entries, leaves every other entry untouched, and deletes the file only if
  the plugin created it. Entries left behind by a crash are cleaned up on the next `session.open`
  there.
- An existing file that is not valid JSON is never overwritten: the plugin warns and skips the
  injection for that session.
- `agy mcp list` lists **only** your global config, so it will not show these entries. Look at
  `<cwd>/.agents/mcp_config.json` instead.

## Files the plugin writes

Under `$PASEO_HOME` (default `~/.paseo`), in `plugin-data/antigravity-cli/`:

| Path | Contents |
|---|---|
| `transcripts/<conversationId>.jsonl` | The timeline rows of a conversation, so `history: "replay"` can restore them after a reload — a subagent's child session is stored the same way, under the subagent's own conversation id. Newest snapshot per row id, capped at 500 rows, flushed on close. Not written when the session has `persist: false`. |
| `attachments/<sessionId>/<n>.<ext>` | Images decoded from prompts. Deleted on `session.close`. |
| `schemas/<sessionId>.json` | The JSON Schema a structured-output turn was launched with. Deleted on `session.close`. |
| `mcp-ledger.json` | Which `paseo-*` entries the plugin wrote, in which workspace, for which sessions, and the `info/exclude` lines it added there. |

Plus, only while sharing is on, `<cwd>/.agents/mcp_config.json` in the session's workspace — and,
when that workspace is inside a git work tree, the two lines in that repository's local
`info/exclude` that keep the file out of its commits.

The plugin reads three things outside those directories: the `toolPermission` value in
`~/.gemini/antigravity-cli/settings.json` (so the approval select can name it), the
conversation index `~/.gemini/antigravity-cli/conversation_summaries.db` (read-only, for session
import), and, while a subagent runs, the transcript file agy names for it (read-only).

## Known limitations

- **`--sandbox` is not demonstrated.** The flag is accepted by the CLI and the turn runs, but with
  permissive Antigravity settings (`allowNonWorkspaceAccess: true`, `trustedWorkspaces` covering
  `$HOME`) a write outside the workspace still succeeded on 2026-09-23, so the plugin does not
  claim the restriction holds.
- **Edit diffs are reconstructed.** The CLI's stream carries only the target file for an edit, so
  the diff is built by comparing file snapshots (the step's own read, or the last content a
  `view_file` step was shown). A file the plugin cannot read, or one that did not change, leaves
  the row without a diff.
- **Transient 503s.** Antigravity occasionally returns `UNAVAILABLE (code 503)`. The turn fails
  with `code: "unavailable"` and a notice asking you to retry; a plain retry usually works.
- **An error result ends the CLI process.** The plugin relaunches it for the next turn with
  `--conversation <id>`, so the conversation continues, but the process does not survive the
  failure.
- **Imported conversations have no history.** Opening a conversation from `session.list` resumes
  it, but its earlier turns are not replayed — Antigravity still has them and the next reply
  continues from them.
- **The command list is read from disk, not from the CLI.** `agy --print /skills --add-dir <dir>`
  does print the skill catalog, but it costs a CLI launch and does not carry the CLI's own workflows
  (`/plan`, `/goal`, …), so the picker is filled by reading the same roots directly and the eight
  workflows above are the ones probed by hand. A skill the CLI would refuse to load can therefore
  appear in the picker; choosing a command the CLI no longer expands sends `/<name>` as literal text
  and the model answers that text instead of running the workflow.
- **Subagents are read-only in Paseo.** A child session shows what the subagent did, but it cannot
  be prompted, and the plugin does not model agy's `@<subagent> <message>` syntax,
  `manage_subagents`, `send_message`, or `browser_subagent` — those remain plain tool rows or text
  sent to the parent. A child session relies on agy's undocumented transcript file; when a CLI
  update changes it, subagents fall back to rows without a child session.

## Terms of service

The Google Antigravity Additional Terms of Service
(<https://antigravity.google/terms>, checked **2026-09-23**) say, in clause 6:

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not
> limited to, using the Service in connection with products not provided by us. Using third party
> software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth)
> is a breach of this Agreement. Such actions may be grounds for suspension or termination of your
> Antigravity and/or Gemini CLI accounts.

What this plugin does about that: it only launches the official `agy` binary you installed, and
lets that binary use whatever session it already has. It never reads, stores, forwards, or
refreshes credentials or OAuth tokens, and it never talks to Antigravity's APIs itself. It does read
the `toolPermission` preference, the read-only conversation index, and subagent transcripts, as
described above.

If you need certainty about how your use is governed, the same terms open by saying that access
through Gemini Enterprise (Google Cloud), Gemini Enterprise for Business, a Google Workspace
subscription on the Google Cloud Pre-GA Offering Terms, or a Gemini Enterprise Agent Platform API
Key is governed by the terms your administrator accepted (and the clauses above do not apply to
you) — that is the route to check with your administrator or Google. This is a description of the
terms as published, not legal advice.
