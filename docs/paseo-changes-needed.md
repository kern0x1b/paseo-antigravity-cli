# Changes this plugin needs from Paseo (and from agy)

The plugin cannot fix these alone. Each entry says what is wrong today, the exact API the plugin
needs, and what the plugin already does so that it can use the change the day it lands. References
are to Paseo 0.9.2: `D` = `packages/server/src/server/agent/plugin-provider.ts`, `M` =
`packages/server/src/server/agent/agent-manager.ts`, `P` = `packages/plugin/src/server/provider.ts`.

Evidence for all of it is in the review this list came from (`antigravity-review.md`, sections 1.1,
1.3 and 3.2), which was read against the daemon log and real agy transcripts.

## 1. `session.persistence` has to reach the agent's persistence (highest value)

**Today.** The plugin emits `session.persistence` as soon as agy reports `init` (`stream.ts`,
`handleAgyEvent`), and the event is valid (`P:1316`). Nothing consumes it: `D:731-733` keeps it on
the bridge, but `translate()` (`D:1291-1321`) has no case for it, so no `AgentStreamEvent` is
produced. `M` copies `describePersistence()` into `agent.persistence` only on a `thread_started`
event, at turn finalize, on permission changes and on rewind. A new conversation's agent therefore
keeps `conversationId: null` until its first turn ends, and while it is null
`PluginAgentSession.id` and `runtimeInfo.sessionId` fall back to a random UUID (`D:1058-1060`,
`D:1136-1140`, `M:3930-3935`) that is not a decodable `plugin:{json}` handle.

That window is where the *twin agent* comes from: import dedup (`import-sessions.ts:343-375`)
compares the listed handle with `agent.persistence.sessionId`, which is still null, so a conversation
that is running is "not imported" and is imported again.

**Needed.** In `D translate()`:

```ts
case "session.persistence":
  return this.bridge.persistence
    ? [{ type: "thread_started", provider: this.provider, sessionId: encodePersistence(this.bridge.persistence) }]
    : [];
```

`publish()` already updates `bridge.persistence` before listeners run (`D:731-735`), and
`onStreamThreadStarted` re-reads `describePersistence()`, so the `sessionId` value is ignored and the
snapshot is persisted through `emitState` as for the built-in providers. Also: do not fall back to the
bridge's UUID for `runtimeInfo.sessionId` when a plugin provider's persistence is not yet known
(`M:3930-3935`, `M:4290`).

**Plugin side, already done.** `session.persistence` is emitted at `init`, with the stable handle
`{ version: 1, data: { conversationId } }`. `session.list` leaves out a conversation a session is
running (`connection.ts`, `runningConversations`) and one that was archived (`archive.ts`), so
listing does not offer what Paseo already has; that only helps for listings from this plugin, which
is why the daemon side is still needed.

## 2. Import must not open a second session for a conversation that is already live

**Today.** `importSession` (`D:943-962`, `import-sessions.ts:343-372`) decides "already imported" by
comparing handle strings. Anything that lists then imports (the import sheet, `paseo agent import`)
can open a conversation twice while the first agent's persistence is not yet recorded — and a direct
import by handle bypasses the plugin's listing filters entirely.

**Needed.** In `importSession`, before opening a session: if an agent (live or stored) already has a
plugin session whose bridge persistence *decodes to the same handle*, return that agent instead of
opening another. Compare decoded persistence, not the `plugin:{…}` string.

**Plugin side.** Handles are canonical (`persistenceFor`), so decoded comparison is well defined.
`session.open` refuses the plugin's own data directory as a workspace (`lifecycle.ts`,
`insidePluginData`), so a twin can never be created in the attachments folder.

## 3. Attribute timeline items to a turn by id

**Today.** `translateTurn` keeps one `currentTurnId` (`D:1323-1328`) and, while a foreground turn is
active, turn events from anything else are dropped (`M:4554-4558`). Items are attributed to whichever
turn is current when they arrive.

**Needed.** An optional `turnId` on `timeline.item` (and `session.usage`), which the daemon uses
instead of `currentTurnId` / `activeForegroundTurnId` when present:

```ts
{ type: "timeline.item"; sessionId: string; item: ProviderTimelineItem; timestamp?: string; turnId?: string }
```

**Plugin side.** The plugin avoids the overlap rather than relying on attribution: a turn is
announced with `session.turn started` only when it is written to a CLI (`turns.ts`,
`writePendingTurn`), a prompt sent while the model is carrying on after a background task is
accepted (`prompt_result`) but not started until that turn is over (`background.ts`, `sendDeferred`),
and an autonomous turn is opened only when nothing is pending (`applyContinuation`). Every row is
published through one function (`publish.ts`, `publish`) and every row's turn is known where it is
built (`PendingTurn.turnId`), so sending `turnId` is a one-line change there once the schema allows
it.

## 4. Let a plugin keep a session's process across a reload (only if that is a goal)

**Today.** A reload stops the plugin's worker (`runtime.ts:1085-1120`, `plugin-process.ts:295-320`),
the plugin closes its connection, and every agy CLI is stopped — with it any background command it
owns (`README`, "Which `agy` gets launched"). The provider guide requires exactly that ("reload and
remove the plugin while a session is active and confirm the session terminates"), and there is no
hook to say otherwise.

**Needed, if surviving a reload is wanted.**

- `close({ reason: "reload" })` on the provider connection, so it can leave a session's process alive;
- a re-attach input carrying the persistence handle, e.g. `{ type: "session.attach"; requestId;
  sessionId; persistence }`, answered with `session.opened`;
- a managed-process registry entry like `managed-processes.ts:252`, so leftovers are reaped at
  daemon start.

Without an agy-side supervisor a task cannot outlive the CLI that owns it, so this alone would not
keep a dev server up (see the agy list below).

**Plugin side.** Each CLI already runs as the leader of its own process group (`agy.ts`), stopping it
takes the group (SIGTERM, then SIGKILL after a grace), and a conversation in progress can be followed
from its transcript without the CLI's stdout (`tail.ts`, `background.ts`), which is what a re-attached
session would do.

## 5. Optional: a background-task item of Paseo's own

A structured `session.background_task` event (or timeline item type) would let the UI show running
background commands without a plugin-invented notice, and an "idle, but waiting for background work"
signal would let a provider say so without the turn staying open. The plugin's notice
(`agy-background-task`) is deliberately small and non-blocking so it can be replaced.

## What agy would need to expose (not Paseo, not the plugin)

- Task id, status and exit on `step_update` events, and a stream-json event when a background task
  ends or wakes the model. Today the plugin reads both from the conversation transcript: a `GENERIC`
  step that stays `RUNNING` starts a task, and a `SYSTEM_MESSAGE` whose `[Message]` header names the
  task as `sender` reports on it (`tasks.ts`). Nothing tells it that a task ended silently: a task
  that crashed the moment it started (an `ERR_MODULE_NOT_FOUND`) wrote no notice at all in one real
  conversation.
- What `status` 6 means on a task step in the conversation database (`step_type` 132). Measured:
  3 exactly for tasks that finished, 6 for the rest (canceled, or never completed).
- A way to pass MCP servers to one process (a flag or environment variable) instead of only through
  files (`~/.gemini/config/mcp_config.json`, `<dir>/.agents/mcp_config.json`, a plugin's own). The
  plugin now gives each session a private folder for it (README, "Sharing Paseo's MCP servers"), but
  the credentials are still in a file.
- A supervisor for background tasks (`agy remote-control` was not explored), if they should outlive a
  CLI.

## Not a code change at all

Something on the machine the review was written on imported every agy conversation every few
seconds (1,067 imports in 15 hours, all from the client id in `~/.paseo/cli-client-id`). Until it is
found and stopped it keeps creating twins for any provider whose persistence arrives late,
independently of item 1.
