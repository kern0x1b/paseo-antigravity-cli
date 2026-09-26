# Running Two Antigravity (agy) Accounts in Paseo: Research & Architecture Design

This document reports findings on running two Antigravity (`agy`) accounts side-by-side in Paseo (matching the pattern used by Claude Code), provides exact evidence from the binaries, configs, and Paseo codebase, and specifies a complete architectural design.

---

## 1. Executive Summary & Four Core Questions

### Q1: Where does `agy` keep account and auth data, and does it support a config/home directory override?
- **Auth Storage**:
  - **Disk files** under `~/.gemini`:
    - `~/.gemini/google_accounts.json`: records active and historical account emails (`{"active": "<email>", "old": []}`).
    - `~/.gemini/oauth_creds.json`: stores OAuth 2.0 tokens (`access_token`, `refresh_token`, `scope`, `token_type`, `id_token`, `expiry_date`).
    - `~/.gemini/installation_id`: UUID identifying the machine installation.
    - `~/.gemini/antigravity-cli/jetski_state.pbtxt`: Protobuf text format tracking `installation_uuid`, post-onboarding completion status, and migration status flags.
    - `~/.gemini/antigravity-cli/settings.json`: application settings (default model, tool permissions, trusted workspaces).
    - `~/.gemini/antigravity-cli/conversation_summaries.db`: SQLite database indexing all conversations and summaries.
    - `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`: step-by-step conversation trajectories.
  - **macOS Keychain**:
    - **Service `"Antigravity Safe Storage"`, Account `"Antigravity Key"`**: holds the encryption key used by Electron `safeStorage` to encrypt/decrypt sensitive credentials and tokens stored on disk.
    - **Service `"gemini"`, Account `"antigravity"`**: holds a base64-encoded JSON blob (`go-keyring-base64:eyJ0b2tlbiI6...`) managed by `github.com/zalando/go-keyring`, containing `{token: {access_token, refresh_token, token_type, expiry}, auth_method, id_token}`.
- **Config / Home Directory Override**:
  - `agy` does **not** support an `--agent-config-dir`, `--config-dir`, or `--home` flag (`agy --help`).
  - No environment variable such as `AGY_CONFIG_DIR`, `GEMINI_CONFIG_DIR`, or `AGY_HOME` exists in the binary.
  - In `third_party/jetski/cli/entrypoints/launchsteps.go:84` (`resolveGeminiDirPath`), the path `".gemini"` is resolved strictly against `os.UserHomeDir()` (which reads `process.env.HOME`).
- **Overriding `HOME` for the `agy` process**:
  - Pointing `HOME` to a custom directory successfully redirects `~/.gemini` to `$NEW_HOME/.gemini`.
  - **Critical breakages**:
    1. **macOS Keychain Failure**: macOS Security framework (`SecKeychainCopyDefault` / `SecItemCopyMatching`) resolves the login keychain at `$HOME/Library/Keychains/login.keychain-db`. Under a custom `HOME` without a keychain directory, keychain operations fail with `SecKeychainCopyDefault: A default keychain could not be found`, and `agy` immediately exits with `error getting token source: You are not logged into Antigravity`.
    2. **Keychain Collision**: If `$NEW_HOME/Library/Keychains` is symlinked to the real login keychain, both accounts share the identical service (`"gemini"`) and account (`"antigravity"`), so logging into the second account overwrites the first account's token in Keychain. A separate keychain file is mandatory.
    3. **Developer Environment**: Because `HOME` is changed, child commands executed by `agy` lose access to `~/.gitconfig` (author name, commit signing), `~/.ssh` (remote Git authentication), and shell configs (`~/.zshrc`, `~/.bashrc`).
    4. **Global Skills & MCP**: Skills in `~/.agents/skills` and `~/.gemini/config/skills` are looked up under `$HOME`.

### Q2: Does Paseo's `extends` mechanism work for plugin providers?
- **No.**
- In `node_modules/@getpaseo/protocol/dist/provider-config.js` (lines 61–75), Paseo's `ProviderOverridesSchema` strictly enforces:
  ```ts
  const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"];
  const validExtendsValues = new Set([...BUILTIN_PROVIDER_IDS, "acp"]);
  ```
- Specifying `"extends": "antigravity-cli"` in `~/.paseo/config.json` fails Zod schema validation:
  `Provider "<id>" extends unknown provider "antigravity-cli".`
- Furthermore, Paseo's daemon (`agent-manager.js`, `provider-launch-config.js`) only uses `agents.providers` overrides to launch built-in CLI providers, not plugin providers.
- Plugin providers are discovered dynamically through IPC via `server.registerProvider(...)`, and the plugin provider protocol does not currently pass `providerId` to `session.open`.

### Q3: What assumes a single account in `paseo-antigravity-cli`?
- Every path in the plugin that relies on `homedir()` or a hardcoded `"antigravity-cli"` directory:
  - `server/plugindata.ts`: hardcodes `~/.paseo/plugin-data/antigravity-cli/`, which houses `archived.json` (`server/archive.ts`), `transcripts/` (`server/transcript.ts`), `attachments/` (`server/attachments.ts`), `mcp/` and `mcp-ledger.json` (`server/mcp.ts`), and `schemas/` (`server/lifecycle.ts`).
  - `server/sessions.ts`: hardcodes `~/.gemini/antigravity-cli/conversation_summaries.db`, causing Account 2 to list and import Account 1's conversations.
  - `server/agysettings.ts`: hardcodes `~/.gemini/antigravity-cli/settings.json`, causing Account 2 to read Account 1's tool permissions.
  - `server/commands.ts`: hardcodes `~/.gemini/` skill and plugin paths.
  - `server/backfill.ts`: hardcodes `~/.gemini/antigravity-cli/brain/<convId>/.../transcript.jsonl`, which breaks live streaming and background task following for Account 2 because Account 2's trajectory is written under Account 2's home.
  - `server/process.ts` & `server/agy.ts`: `AgyProcess` must pass `env.HOME = accountHome` to isolate `agy`.

### Q4: Are quotas per Google account?
- **Yes.**
- `agy` communicates with Google's Cloud Code Prediction Service (`FetchQuotaStatus`, `RetrieveUserQuotaSummary`) using the OAuth access token.
- Google tracks prompt credits, requests per minute, daily limits, and Google One AI tier per authenticated Google Account identity (`QuotaUser`, `UtaUserKey`).
- A second Google account provides its own distinct quota bucket, doubling the daily/hourly Gemini budget.

---

## 2. Deep Dive with Evidence

### 2.1 Antigravity Auth & Config Internals (`agy`)

#### Files on Disk
Inspection of `~/.gemini` reveals the following structure:
```
~/.gemini/
├── google_accounts.json         # Active account identifier: {"active": "user@gmail.com", "old": []}
├── oauth_creds.json            # OAuth token payload: access_token, refresh_token, id_token, expiry
├── installation_id             # Machine UUID
├── config/
│   ├── mcp_config.json         # Global MCP server definitions
│   └── projects/               # Project-level permission overrides
└── antigravity-cli/
    ├── settings.json           # User settings (toolPermission, model, trustedWorkspaces)
    ├── conversation_summaries.db # SQLite database of conversation metadata and summaries
    ├── jetski_state.pbtxt      # Onboarding status and installation UUID
    ├── brain/                  # Trajectories: <conversation-id>/.system_generated/logs/transcript.jsonl
    └── log/                    # CLI execution logs
```

#### macOS Keychain Usage
`agy` uses two separate Keychain entries on macOS:
1. **Electron Safe Storage**:
   - Service: `Antigravity Safe Storage`
   - Account: `Antigravity Key`
   - Purpose: Master key used by Chromium/Electron `safeStorage` to encrypt credentials on disk.
2. **Go Keyring OAuth Token**:
   - Service: `gemini`
   - Account: `antigravity`
   - Implementation: `google3/third_party/golang/github_com/zalando/go_keyring/v/v0/keyring.macOSXKeychain.Get`
   - Value: `go-keyring-base64:<base64-json>`, containing:
     ```json
     {
       "token": {
         "access_token": "...",
         "token_type": "Bearer",
         "refresh_token": "...",
         "expiry": "2026-..."
       },
       "auth_method": "oauth-personal",
       "id_token": "..."
     }
     ```

#### Absence of Config Directory Override Flag or Environment Variable
Inspection of `agy --help` reveals:
```
Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c, --continue                  Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --disable-slash-commands        Disable slash command and skill expansion in print mode
  --effort                        Reasoning effort for the current CLI session (low|medium|high|max)
  -i, --prompt-interactive        Run an initial prompt interactively and continue the session
  --input-format                  Input format for print mode (text, stream-json)
  --json-schema                   Optional JSON schema string or path to a schema file
  --log-file                      Override CLI log file path
  --mode                          Set the agent execution mode for this session
  --model                         Model for the current CLI session
  --new-project                   Create a new project for this session
  --output-format                 Output format for print mode (text, json, stream-json)
  -p, --print                     Run a single prompt non-interactively
  --print-timeout                 Optional time limit for print mode
  --project                       Project ID or project name
  --prompt                        Alias for --print
  --remote-control                Create a remote connection for the CLI session
  --sandbox                       Run in a sandbox with terminal restrictions enabled
```
There is no `--config-dir`, `--config`, or `--home` flag.

Disassembly of `resolveGeminiDirPath` in `/opt/homebrew/bin/agy` (`launchsteps.go:84`):
```text
0x10264706c: adrp x6, #0x10304d000
0x102647070: add x6, x6, #0x2a7      ; "Failed to resolve GeminiDir %q: %v, falling back to default"
0x102647110: adrp x6, #0x103050000
0x102647114: add x6, x6, #0x3cc      ; "Failed to get default GeminiDir: %v, using hardcoded .gemini"
0x102647130: adrp x0, #0x102e29000
0x102647134: add x0, x0, #0x61b      ; ".gemini"
0x102647138: orr x1, xzr, #7         ; len = 7
0x10264713c: bl #0x100cf1e10         ; filepath.Join(os.UserHomeDir(), ".gemini")
```
When `HOME` is overridden, `launchsteps.go:84` outputs:
`Failed to resolve GeminiDir ".gemini": .gemini must be an absolute path: path is not absolute, falling back to default`
and falls back to `filepath.Join(os.UserHomeDir(), ".gemini")`.

#### Overriding `HOME`: Test Results and Evidence
When running `HOME=/path/to/custom agy models`:
1. `agy` creates `$HOME/.gemini/antigravity-cli/` and `$HOME/.gemini/config/`.
2. Output:
   `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`
   Log output (`cli-*.log`):
   `W0926 19:35:02.706968 cache.go:135] Cache(loadCodeAssistResponse): Singleflight refresh failed: error getting token source: You are not logged into Antigravity.`
3. Cause: Testing `HOME=/path/to/custom security default-keychain` outputs:
   `security: SecKeychainCopyDefault: A default keychain could not be found.`
   Because macOS resolves keychains relative to `$HOME/Library/Keychains`, `go-keyring` cannot access the Keychain.
4. When `$HOME/Library/Keychains` is present and points to a valid keychain, `agy` authenticates successfully.

---

### 2.2 Paseo's `extends` Mechanism

#### Contract and Schema Enforcement
In `node_modules/@getpaseo/protocol/dist/provider-config.js` (lines 61–75):
```ts
const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"];
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const ProviderOverridesSchema = z
    .record(z.string(), ProviderOverrideSchema)
    .superRefine((providers, ctx) => {
    const builtinProviderIdSet = new Set(BUILTIN_PROVIDER_IDS);
    const validExtendsValues = new Set([...BUILTIN_PROVIDER_IDS, "acp"]);
    for (const [providerId, provider] of Object.entries(providers)) {
        ...
        if (provider.extends && !validExtendsValues.has(provider.extends)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [providerId, "extends"],
                message: `Provider "${providerId}" extends unknown provider "${provider.extends}".`,
            });
        }
    }
});
```

Testing this against Node.js:
```bash
node -e '
const { ProviderOverridesSchema } = require("./node_modules/@getpaseo/protocol/dist/provider-config.js");
console.log(ProviderOverridesSchema.safeParse({
  "antigravity-work": { "extends": "antigravity-cli", "label": "Work", "enabled": true }
}));
'
```
Output:
```json
{
  "success": false,
  "error": [
    {
      "code": "custom",
      "path": ["antigravity-work", "extends"],
      "message": "Provider \"antigravity-work\" extends unknown provider \"antigravity-cli\"."
    }
  ]
}
```

#### Plugin Provider Architecture
In Paseo (`packages/server/src/server/agent/provider-snapshot-manager.ts` and `plugin-provider.ts`):
1. Built-in providers configured via `agents.providers` are launched as external command-line binaries via `resolveProviderLaunch()` in `provider-launch-config.js`.
2. Plugin providers are registered via `server.registerProvider(...)` in plugin subprocesses (`plugin-process.js`). The daemon receives their metadata via a `ready` IPC message and manages them through `PluginAgentClientRegistry`.
3. `ProviderSessionConfig` passed to `session.open` contains `{ cwd, env, systemPrompt, mcpServers, toolPolicy, model, mode, settings, providerOptions, persist }`. It does **not** include `providerId`.

---

### 2.3 Single-Account Assumptions in `paseo-antigravity-cli`

| File | Lines | Current Hardcoded Assumption | Impact on Multi-Account |
|---|---|---|---|
| `server/plugindata.ts` | 8–11 | `join(home, "plugin-data", "antigravity-cli", ...segments)` | All plugin-data (transcripts, attachments, schemas, MCP configs) is stored in one directory. |
| `server/archive.ts` | 23, 54 | `pluginDataDir("archived.json")` | Archived conversations from both accounts are stored in a single JSON file; archiving in one hides it in the other. |
| `server/transcript.ts` | 117 | `pluginDataDir("transcripts", ...)` | Cached conversation timeline transcripts share the same folder. |
| `server/attachments.ts` | 12 | `pluginDataDir("attachments", ...)` | Prompt attachments share the same parent folder. |
| `server/mcp.ts` | 51, 118, 174 | `pluginDataDir("mcp", ...)`, `pluginDataDir("mcp-ledger.json")` | MCP credentials and configuration files share a single folder and ledger. |
| `server/lifecycle.ts` | 34, 85 | `insidePluginData()`, `pluginDataDir("schemas", ...)` | Workspace path validation and schema generation use the single plugin directory. |
| `server/housekeeping.ts` | 26, 35 | `pluginDataDir("attachments")`, `pluginDataDir("schemas")`, `pluginDataDir("transcripts")` | Cleanup sweeps assuming only `antigravity-cli` directory exists. |
| `server/sessions.ts` | 84, 127 | `join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db")` | Conversation listing queries the primary user's SQLite database. Account 2 lists Account 1's conversations. |
| `server/agysettings.ts` | 13 | `join(homedir(), ".gemini", "antigravity-cli", "settings.json")` | Tool approval settings are read exclusively from the primary user's settings. |
| `server/commands.ts` | 82–84, 147–168 | `join(homedir(), ".gemini", ...)` | Skill discovery, plugins, and built-ins are resolved exclusively from the primary `homedir()`. |
| `server/backfill.ts` | 29–32 | `join(homedir(), ".gemini", "antigravity-cli", "brain", conversationId, ...)` | Transcript backfill reads trajectory files from the primary user's `brain/` folder. Account 2 turns cannot follow their transcripts. |
| `server/process.ts` | 32 | `env: session.config.env` | Passes session env to `AgyProcess`. |
| `server/agy.ts` | 192 | `env: { ...process.env, ...this.config.env }` | Spawns `agy` with merged environment; if `HOME` is not set per account, it defaults to the daemon's `process.env.HOME`. |

---

### 2.4 Quota and Rate Limit Mechanics

In `/opt/homebrew/bin/agy`, inspection of symbols reveals:
- Protocol buffer messages:
  - `google3/google/internal/cloud/code/v1internal/quota_summary.pb.go`
  - `google3/learning/genai/beyond/server/quota/proto/quota_go_proto`
- Functions:
  - `RetrieveUserQuota`
  - `RetrieveUserQuotaSummary`
  - `FetchQuotaStatus`
  - `UserUsedPromptCredits`
  - `UserUsedFlowCredits`
  - `RefreshG1Credits`
- Quotas are billed and enforced by Google's backend per authenticated Google account (via Google OAuth 2.0 user tokens).
- A second Google account provides a separate allocation of daily prompts, tokens, and rate limits.

---

## 3. Concrete Architecture & Design

### 3.1 The User's Desired Configuration (`~/.paseo/config.json`)

To configure side-by-side accounts identically to Claude Code:
```json
{
  "agents": {
    "providers": {
      "antigravity-work": {
        "extends": "antigravity-cli",
        "label": "Antigravity Work",
        "description": "Google Antigravity - Work Account",
        "env": {
          "ANTIGRAVITY_HOME": "/Users/you/.antigravity-work",
          "HOME": "/Users/you/.antigravity-work"
        },
        "enabled": true
      }
    }
  }
}
```

### 3.2 What Paseo Itself Would Need (Because `extends` Does Not Reach Plugins)

1. **Schema Validation (`@getpaseo/protocol`)**:
   - File: `packages/protocol/src/provider-config.ts`
   - In `ProviderOverridesSchema`, change `validExtendsValues`:
     ```ts
     // Today:
     const validExtendsValues = new Set([...BUILTIN_PROVIDER_IDS, "acp"]);

     // Needed:
     // Allow extending any installed plugin provider ID:
     export function createProviderOverridesSchema(knownProviderIds: readonly string[]) { ... }
     // Or relax validation to allow matching PROVIDER_ID_PATTERN for extends:
     const isKnownOrCustom = (id: string) => validExtendsValues.has(id) || PROVIDER_ID_PATTERN.test(id);
     ```
2. **Provider Resolution in Daemon (`@getpaseo/server`)**:
   - File: `packages/server/src/server/agent/provider-snapshot-manager.ts`
   - In `replacePluginProviders(registrations)`:
     When an entry in `agents.providers` specifies `extends: "antigravity-cli"`, Paseo must synthesize an extended provider client pointing to the same plugin provider bridge, parameterized with:
     - `providerId`: `"antigravity-work"`
     - Custom `label`, `description`, `icon`
     - Custom `env` overlay (`ANTIGRAVITY_HOME`, `HOME`)
3. **Session Launch Context (`@getpaseo/server` & `@getpaseo/plugin`)**:
   - File: `packages/server/src/server/agent/plugin-provider.ts`
   - In `mapSessionConfig`, forward `providerId` and the extended `env`:
     ```ts
     function mapSessionConfig(config, launchContext, persist) {
       return {
         ...
         providerId: config.provider, // Expose which provider identity this session belongs to
         env: { ...launchContext?.env },
       };
     }
     ```
   - In `packages/plugin/src/server/provider.ts`:
     Add `providerId?: string` to `ProviderSessionConfig`.

---

### 3.3 Plugin Changes Needed in `paseo-antigravity-cli`

Once Paseo forwards `env` / `providerId` to the plugin:

1. **`server/plugindata.ts`**:
   Accept an account / provider namespace:
   ```ts
   export function pluginDataDir(accountOrProvider: string, ...segments: readonly string[]): string {
     const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
     return join(home, "plugin-data", safePathSegment(accountOrProvider), ...segments);
   }
   ```
2. **`server/sessions.ts`**:
   Resolve the conversation database from the account's home:
   ```ts
   export function conversationDbPath(accountHome: string = homedir()): string {
     return join(accountHome, ".gemini", "antigravity-cli", "conversation_summaries.db");
   }
   ```
   In `listConversations`, accept `accountHome` (derived from `session.config.env.ANTIGRAVITY_HOME ?? session.config.env.HOME ?? homedir()`).
3. **`server/agysettings.ts`**:
   Parameterize `readToolPermission(accountHome?: string)`.
4. **`server/commands.ts`**:
   Parameterize skill root lookups with `accountHome`.
5. **`server/backfill.ts`**:
   Resolve the brain directory using the session's specific `accountHome`:
   ```ts
   join(session.accountHome, ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs", "transcript.jsonl")
   ```
6. **`server/archive.ts`, `server/transcript.ts`, `server/attachments.ts`, `server/mcp.ts`**:
   Scope each store to `pluginDataDir(session.providerId ?? "antigravity-cli", ...)`.
7. **`server/process.ts` & `server/agy.ts`**:
   Ensure `HOME` in `session.config.env` overrides `process.env.HOME` when spawning `agy`:
   ```ts
   env: { ...process.env, ...this.config.env }
   ```
   (which `server/agy.ts:192` already supports if `HOME` is in `this.config.env`).

---

### 3.4 Step-by-Step: Logging In Second Account Without Touching the First

Because `agy` uses the macOS Keychain (`"Antigravity Safe Storage"` and `"gemini"`), running a second account requires an isolated Keychain database so it does not overwrite the primary account's credentials.

#### Step 1: Create the Isolated Account Home Directory
```bash
export AGY_WORK_HOME="$HOME/.antigravity-work"
mkdir -p "$AGY_WORK_HOME/Library/Keychains"
mkdir -p "$AGY_WORK_HOME/.gemini"
```

#### Step 2: Create a Dedicated Keychain for the Second Account
Create an isolated keychain in the new directory and set it as the default keychain within that subshell:
```bash
# Create the work keychain with an empty password (or dedicated password)
security create-keychain -p "" "$AGY_WORK_HOME/Library/Keychains/login.keychain-db"
security set-keychain-settings "$AGY_WORK_HOME/Library/Keychains/login.keychain-db"
```

#### Step 3: Symlink Development Tools (Non-Auth Files)
Preserve Git credentials, SSH keys, and shell tools:
```bash
ln -s "$HOME/.gitconfig" "$AGY_WORK_HOME/.gitconfig"
ln -s "$HOME/.ssh" "$AGY_WORK_HOME/.ssh"
```

#### Step 4: Perform Interactive Login Under the Work Home
Run `agy` interactively with `HOME` set to the isolated work directory. This launches the browser OAuth flow and signs in to the second Google account:
```bash
HOME="$AGY_WORK_HOME" agy
```
- Complete the Google OAuth authentication in the browser with the **work account**.
- `agy` stores the work account OAuth credentials in `$AGY_WORK_HOME/.gemini/` and the work keychain in `$AGY_WORK_HOME/Library/Keychains/login.keychain-db`.
- The primary account (`~/.gemini` and the primary macOS login keychain) remains 100% untouched.

#### Step 5: Verify Both Accounts Independently
```bash
# Account 1 (Personal)
agy models

# Account 2 (Work)
HOME="$AGY_WORK_HOME" agy models
```
Both print available models for their respective Google accounts.

---

## 4. Implementation Status & Conclusion

- **Finding**: Paseo core changes are required before `~/.paseo/config.json` can support `"extends": "antigravity-cli"`:
  - `@getpaseo/protocol` currently rejects `extends` pointing to plugin providers.
  - Paseo daemon does not route extended providers to plugin provider bridges.
- **Action**: Per user instruction (*"Then implement the plugin changes on a new branch `multi-account` with tests if the design needs no Paseo change; otherwise stop at the document"*), implementation on a branch is suspended pending the Paseo core changes detailed in Section 3.2.
