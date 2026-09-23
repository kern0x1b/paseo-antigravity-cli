import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * The slash commands the composer offers. Paseo sends one as `/<name> <arguments>`, which the CLI
 * expands only when the process was launched without `--disable-slash-commands` — see the launch
 * profile in `provider.ts`, which relaunches for exactly those turns.
 */
export interface AgyCommand {
  readonly name: string;
  readonly description: string;
}

/**
 * The CLI's own workflows. Every one of them was verified to expand in `stream-json` mode with
 * `--log-file` (`Print mode: expanded slash command "<name>" (system)`) on Antigravity CLI 1.2.9,
 * 2026-09-23; the table and the raw commands are recorded under Task 19 in tasks/todo.md.
 *
 * Commands the CLI answers itself (`/skills`, `/usage`, `/model`, `/btw`, `/tasks`, …) are
 * deliberately absent: in print mode they fail the whole turn with `ERROR` and exit 2 instead of
 * being ignored, so sending one would kill the turn it was meant to start.
 */
const SYSTEM_COMMANDS: readonly AgyCommand[] = [
  {
    name: "plan",
    description: "Plan the task before making changes (Antigravity's plan mode).",
  },
  {
    name: "goal",
    description: "Run the task as a long-running goal and keep working until it is complete.",
  },
  {
    name: "grill-me",
    description: "Interview you about the task, one question at a time, before starting work.",
  },
  {
    name: "teamwork-preview",
    description: "Approach the task with a team of autonomous agents.",
  },
  {
    name: "learn",
    description: "Record a behaviour for this workspace, in its GEMINI.md.",
  },
  {
    name: "schedule",
    description: "Create a recurring, scheduled run of a task.",
  },
];

/**
 * The customization roots the CLI reads a workspace's skills from. A probe skill placed in each of
 * the four expanded as `(skill)` on 2026-09-23, which is the evidence for reading all four rather
 * than the documented `.agents` alone.
 */
const WORKSPACE_ROOTS = [".agents", ".agent", "_agents", "_agent"] as const;

/**
 * The skill roots the CLI reads outside a workspace, in the CLI's own precedence order. Probed
 * 2026-09-23 on CLI 1.2.9: a skill in each of the three expanded as `(skill)` in `stream-json`
 * mode, and when one name was installed in all of them the CLI listed — and ran — the highest of
 * the three, after the workspace copy.
 */
const GLOBAL_ROOTS = [
  ".gemini/antigravity-cli/skills",
  ".gemini/config/skills",
  ".gemini/skills",
] as const;

/**
 * Where the shared skills installer other agent CLIs use puts its skills. Antigravity never reads
 * this directory — probed 2026-09-23: neither a probe skill there nor an installed one expanded,
 * and `agy --print /skills` never listed one — so this plugin expands those skills itself, and
 * only for names no command the CLI does expand has claimed. The other agent CLIs are its owner;
 * this plugin only reads it.
 */
const SHARED_SKILL_ROOT = ".agents/skills";

/** A plugin-expanded skill's own directory is handed to the CLI, so a turn can read its assets. */
export const MAX_SKILL_BYTES = 64 * 1024;

/** A skill the plugin expands itself, because the CLI does not read the directory it lives in. */
export interface ExpandedSkill {
  readonly name: string;
  readonly description: string;
  /** The skill's own directory: the turn's extra `--add-dir` and its base for relative paths. */
  readonly dir: string;
  /** The `SKILL.md` the body comes from. */
  readonly path: string;
}

/**
 * Bounds for a read that the draft composer repeats on every model, mode, and tier change: a
 * bounded directory listing per root, the frontmatter head of each SKILL.md, and a cap on how many
 * commands the session publishes.
 */
const MAX_DIRS_PER_ROOT = 64;
const MAX_COMMANDS = 64;
const SKILL_HEAD_BYTES = 4 * 1024;
const DESCRIPTION_LIMIT = 240;

/** A skill the CLI would not accept as a command name is not one the composer should offer. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const FIELD = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const QUOTED = /^"(.*)"$|^'(.*)'$/;
const BLOCK_SCALAR = /^[>|][-+0-9]*$/;

/**
 * The commands the composer can offer, and which of them this plugin expands itself. The list
 * holds the CLI's own workflows, then the skills installed for this workspace, for every
 * workspace, by its plugins, and the set the CLI ships with — then the shared installer's skills,
 * for the names none of the CLI's own claimed.
 */
export interface DiscoveredCommands {
  /** What the composer offers, in the order it offers them. */
  readonly commands: readonly AgyCommand[];
  /** The commands this plugin expands itself, keyed by the name it publishes them under. */
  readonly expanded: ReadonlyMap<string, ExpandedSkill>;
}

/** Every command the composer can offer, with the ones the CLI does not expand marked as ours. */
export async function discoverCommands(cwd: string): Promise<DiscoveredCommands> {
  const commands = new Map<string, AgyCommand>();
  for (const command of SYSTEM_COMMANDS) commands.set(command.name, command);
  for (const root of WORKSPACE_ROOTS) await collectSkills(join(cwd, root, "skills"), commands);
  // A global skill is addressed by its own name and outranks the CLI's own skills, which is why
  // these are read before the plugins and the built-in set.
  for (const root of GLOBAL_ROOTS) await collectSkills(join(homedir(), root), commands);
  // Verified 2026-09-23: `/firebase:firebase-basics` expanded, so a plugin's skills are addressed
  // by the plugin's directory name and the skill's own name. A plugin that keeps its one skill
  // directly in `skills/` is addressed with a `..` placeholder instead of a directory:
  // `/android-cli-plugin:..:android-cli` expanded, while `/android-cli-plugin:android-cli` did not.
  const plugins = join(homedir(), ".gemini", "config", "plugins");
  for (const plugin of await subdirectories(plugins)) {
    const prefix = `${basename(plugin)}:`;
    const root = join(plugin, "skills");
    const flat = await readSkill(join(root, "SKILL.md"));
    if (flat !== null) {
      remember(commands, { name: `${prefix}..:${flat.name}`, description: flat.description });
    }
    await collectSkills(root, commands, prefix);
  }
  // Where the CLI unpacks the skills it ships with, one directory per skill.
  const builtin = join(homedir(), ".gemini", "antigravity-cli", "builtin", "skills");
  await collectSkills(builtin, commands);
  // Last, because a name the CLI expands itself is the one the user gets: a skill here whose name
  // is taken is left to the CLI's own copy rather than offered twice with different behaviour.
  const expanded = new Map<string, ExpandedSkill>();
  for (const dir of await subdirectories(join(homedir(), SHARED_SKILL_ROOT))) {
    const path = join(dir, "SKILL.md");
    const skill = await readSkill(path);
    if (skill === null || commands.has(skill.name)) continue;
    remember(commands, skill);
    if (commands.has(skill.name)) expanded.set(skill.name, { ...skill, dir, path });
  }
  return { commands: [...commands.values()], expanded };
}

/**
 * The turn text for a plugin-expanded skill: a skill is instructions for the model, and the CLI
 * never sees the `/name`, so the body itself is the prompt. The directory line is what lets the
 * instructions use their own relative paths, and the request is appended exactly as typed.
 */
export type SkillPrompt =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "unreadable"; readonly message: string };

export async function renderSkillPrompt(
  skill: ExpandedSkill,
  request: string,
): Promise<SkillPrompt> {
  let raw: Buffer;
  try {
    raw = await readFile(skill.path);
  } catch (error) {
    return { kind: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  if (raw.byteLength > MAX_SKILL_BYTES) return { kind: "too_large", bytes: raw.byteLength };
  const text = raw.toString("utf8");
  const frontmatter = FRONTMATTER.exec(text);
  const body = (frontmatter ? text.slice(frontmatter[0].length) : text).trim();
  return {
    kind: "text",
    text:
      `[Skill: ${skill.name}]\n${body}` +
      `\n\nSkill directory: ${skill.dir} — resolve relative paths in these instructions against it.` +
      (request.length > 0 ? `\n\nUser request: ${request}` : ""),
  };
}

/** One `SKILL.md` per subdirectory is the shape the CLI lists as a skill command. */
async function collectSkills(
  root: string,
  commands: Map<string, AgyCommand>,
  prefix = "",
): Promise<void> {
  for (const dir of await subdirectories(root)) {
    const skill = await readSkill(join(dir, "SKILL.md"));
    if (skill === null) continue;
    remember(commands, { name: `${prefix}${skill.name}`, description: skill.description });
  }
}

/** The CLI resolves a slash name to one command, and the composer's list stays bounded. */
function remember(commands: Map<string, AgyCommand>, command: AgyCommand): void {
  if (commands.size >= MAX_COMMANDS || commands.has(command.name)) return;
  commands.set(command.name, command);
}

/** A missing or unreadable root is simply a root with no skills in it. */
async function subdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort()
      .slice(0, MAX_DIRS_PER_ROOT);
  } catch {
    return [];
  }
}

/**
 * A skill file is otherwise arbitrary markdown, so only its head is read and only the two fields
 * the composer needs are taken from the frontmatter. A file whose frontmatter names no usable
 * command is skipped: the CLI does not expand one either (probed 2026-09-23 with a
 * frontmatter-less SKILL.md and with a directory whose name differs from its own `name`).
 */
async function readSkill(path: string): Promise<AgyCommand | null> {
  let head: string;
  try {
    head = (await readFile(path)).subarray(0, SKILL_HEAD_BYTES).toString("utf8");
  } catch {
    return null;
  }
  const match = FRONTMATTER.exec(head);
  if (!match) return null;
  const block = match[1] ?? "";
  const name = field(block, "name");
  if (name === null || !COMMAND_NAME.test(name)) return null;
  return { name, description: describeSkill(field(block, "description") ?? "") };
}

/** A frontmatter scalar, including the folded and literal blocks the CLI's own skills use. */
function field(block: string, key: string): string | null {
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = FIELD.exec(lines[index] ?? "");
    if (!match || match[1] !== key) continue;
    const inline = (match[2] ?? "").trim();
    if (inline.length > 0 && !BLOCK_SCALAR.test(inline)) {
      const quoted = QUOTED.exec(inline);
      return quoted ? (quoted[1] ?? quoted[2] ?? "") : inline;
    }
    const parts: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (line.trim().length === 0) continue;
      if (!/^[ \t]/.test(line)) break;
      parts.push(line.trim());
    }
    return parts.join(" ");
  }
  return null;
}

/**
 * The description Paseo shows beside the command, on one bounded line: the draft composer reads
 * the whole list on every model, mode, and tier change, and the CLI's own skills carry paragraphs.
 */
function describeSkill(description: string): string {
  const single = description.replace(/\s+/g, " ").trim();
  if (single.length <= DESCRIPTION_LIMIT) return single;
  const cut = single.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
