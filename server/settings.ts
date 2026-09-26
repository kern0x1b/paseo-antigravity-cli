/**
 * The composer's settings and selectors: what is shown, and how a session's own settings and
 * provider options are read.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  ProviderConfigState,
  ProviderSessionConfig,
  ProviderSetting,
} from "@getpaseo/plugin/server/provider";
import { readToolPermission } from "./agysettings";
import { currentModels, DEFAULT_MODE_ID, MODES, resolveThinking } from "./catalog";
import type { JsonValue } from "./json";
import { mcpSessionConfigPath } from "./mcp";
import type { Session } from "./state";

export function configState(session: Session): ProviderConfigState {
  // The tier belongs to the selected model, so the composer's axis is that model's own tiers and
  // the committed option is the one the next launch will actually pass.
  const thinking = resolveThinking(session.selection.model, session.selection.thinkingOption);
  return {
    model: session.selection.model,
    mode: session.selection.mode ?? DEFAULT_MODE_ID,
    thinkingOption: thinking.option,
    models: currentModels(),
    modes: MODES,
    thinkingOptions: thinking.options,
    settings: buildSettings(session),
  };
}

function buildSettings(session: Session): readonly ProviderSetting[] {
  const policy = approvalPolicy(session);
  // Antigravity decides through its own setting unless the user overrides it here, so the row
  // names that value rather than guessing at what a headless run will do.
  const permission = readToolPermission() ?? "unknown";
  return [
    {
      type: "select",
      id: "approvalPolicy",
      label: "Tool approval",
      description:
        policy === "skip"
          ? `Every tool runs without asking (--dangerously-skip-permissions), overriding Antigravity's toolPermission (${permission}).`
          : `Antigravity decides, using its own toolPermission setting (${permission}).`,
      value: policy,
      options: [
        { label: "Use Antigravity setting", value: "agy" },
        { label: "Skip all permissions", value: "skip" },
      ],
    },
    {
      type: "select",
      id: "sandbox",
      label: "Sandbox",
      description: "On passes --sandbox, which restricts what terminal commands can reach.",
      value: onOff(session.settings.sandbox),
      options: ON_OFF_OPTIONS,
    },
    {
      type: "select",
      id: "shareMcp",
      label: "Share Paseo tools with Antigravity",
      description:
        Object.keys(session.config.mcpServers).length === 0
          ? "Paseo has no MCP servers configured for this session, so there is nothing to share."
          : `On writes Paseo's MCP servers as paseo-* entries into ${mcpSessionConfigPath(session.sessionId)}, a folder private to this session that Antigravity is given. That file holds their credentials, and is deleted when the session closes.`,
      value: onOff(session.settings.shareMcp),
      options: ON_OFF_OPTIONS,
    },
  ];
}

/**
 * Paseo draws plugin toggles as icon-only buttons with no on/off state, so a boolean setting is
 * offered as a two-option select instead: Paseo then shows the current value as a pill. A value
 * saved while the setting was a toggle (`true`/`false`) still reads correctly.
 */
const ON_OFF_OPTIONS = [
  { label: "Off", value: "off" },
  { label: "On", value: "on" },
] as const;

function onOff(value: JsonValue | undefined): "on" | "off" {
  return isSettingOn(value) ? "on" : "off";
}

/** `true` and `"on"` are on; everything else — `false`, `"off"`, a missing setting — is off. */
export function isSettingOn(value: JsonValue | undefined): boolean {
  return value === true || value === "on";
}

/**
 * `agy` defers approval to Antigravity's own `toolPermission` setting and passes no flag; `skip`
 * passes --dangerously-skip-permissions. A session persisted before this select existed carries
 * the removed `autoApprove` toggle, which was on by default and meant the same as `skip`.
 */
export function approvalPolicy(session: Session): "agy" | "skip" {
  const value = session.settings.approvalPolicy;
  if (value === "agy" || value === "skip") return value;
  return session.settings.autoApprove === true ? "skip" : "agy";
}

export function readProviderOptions(config: ProviderSessionConfig): {
  agyPath?: string;
  extraArgs?: readonly string[];
  addDirs?: readonly string[];
} {
  const options = config.providerOptions ?? {};
  const rawPath = options.agyPath;
  const rawArgs = options.extraArgs;
  const rawDirs = options.addDirs;
  return {
    agyPath: typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath : undefined,
    extraArgs: Array.isArray(rawArgs)
      ? rawArgs.filter((arg): arg is string => typeof arg === "string")
      : undefined,
    addDirs: Array.isArray(rawDirs)
      ? rawDirs.filter((dir): dir is string => typeof dir === "string")
      : undefined,
  };
}

/**
 * `agy` resolves every `--add-dir` against the filesystem at startup, so a path that is not an
 * absolute existing directory is dropped here, and the session says which ones were left out
 * instead of failing the launch or letting the model see a directory the user did not intend.
 */
export async function checkAddDirs(
  paths: readonly string[] | undefined,
): Promise<{ kept: string[]; dropped: string[] }> {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const path of paths ?? []) {
    if (!isAbsolute(path)) {
      dropped.push(path);
      continue;
    }
    try {
      if ((await stat(path)).isDirectory()) kept.push(path);
      else dropped.push(path);
    } catch {
      dropped.push(path);
    }
  }
  return { kept, dropped };
}
