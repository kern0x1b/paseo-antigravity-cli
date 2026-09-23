import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverCommands, renderSkillPrompt } from "./commands";

const originalHome = process.env.HOME;

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-commands-home-"));
  workspace = mkdtempSync(join(tmpdir(), "antigravity-commands-work-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function skill(frontmatter: string, body = "Reply with exactly: ok\n"): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function writeSkill(root: string, dir: string, content: string): void {
  const path = join(workspace, root, "skills", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), content, "utf8");
}

/** The roots the CLI reads outside a workspace, highest precedence first. */
const GLOBAL_ROOTS = [".gemini/antigravity-cli/skills", ".gemini/config/skills", ".gemini/skills"];

function writeGlobalSkill(root: string, dir: string, content: string): void {
  const path = join(home, root, dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), content, "utf8");
}

async function names(): Promise<string[]> {
  return (await discoverCommands(workspace)).commands.map((command) => command.name);
}

describe("discoverCommands", () => {
  it("offers the CLI's own workflows first", async () => {
    expect((await discoverCommands(workspace)).commands).toEqual([
      { name: "plan", description: expect.any(String) },
      { name: "goal", description: expect.any(String) },
      { name: "grill-me", description: expect.any(String) },
      { name: "teamwork-preview", description: expect.any(String) },
      { name: "learn", description: expect.any(String) },
      { name: "schedule", description: expect.any(String) },
    ]);
  });

  it("finds a skill in every customization root the CLI reads", async () => {
    // Probed 2026-09-23: a skill in each of the four expanded as `(skill)`.
    for (const [index, root] of [".agents", ".agent", "_agents", "_agent"].entries()) {
      writeSkill(root, `root-${index}`, skill(`name: root-${index}\ndescription: Root ${index}`));
    }

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.slice(6)).toEqual([
      { name: "root-0", description: "Root 0" },
      { name: "root-1", description: "Root 1" },
      { name: "root-2", description: "Root 2" },
      { name: "root-3", description: "Root 3" },
    ]);
  });

  it("uses the skill's frontmatter name and reads a folded description", async () => {
    // The directory name is not the command: `/probe-dir-name` did not expand, `/probe-front-name`
    // did (probed 2026-09-23).
    writeSkill(
      ".agents",
      "probe-dir-name",
      skill("name: probe-front-name\ndescription: >-\n  A folded description\n  over two lines"),
    );

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "probe-front-name",
      description: "A folded description over two lines",
    });
  });

  it("skips a SKILL.md the CLI would not treat as a command", async () => {
    writeSkill(".agents", "no-frontmatter", "Just a body, with no frontmatter at all.\n");
    writeSkill(".agents", "no-name", skill("description: A skill without a name"));
    writeSkill(".agents", "bad-name", skill("name: two words\ndescription: Not a command name"));
    writeSkill(".agents", "not-a-skill", skill("name: not-a-skill"));
    rmSync(join(workspace, ".agents", "skills", "not-a-skill", "SKILL.md"));

    expect(await names()).toEqual([
      "plan",
      "goal",
      "grill-me",
      "teamwork-preview",
      "learn",
      "schedule",
    ]);
  });

  it("bounds a long description to one line", async () => {
    writeSkill(".agents", "wordy", skill(`name: wordy\ndescription: ${"word ".repeat(200)}`));

    const command = (await discoverCommands(workspace)).commands.at(-1);
    expect(command?.description.length).toBeLessThanOrEqual(241);
    expect(command?.description.endsWith("…")).toBe(true);
  });

  it("lists the skills of the plugins installed for the CLI", async () => {
    // Probed 2026-09-23: `/firebase:firebase-basics` expanded, named for the plugin directory and
    // the skill's own frontmatter name.
    const path = join(home, ".gemini", "config", "plugins", "firebase", "skills", "firebase_basics");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      skill("name: firebase-basics\ndescription: Firebase basics"),
      "utf8",
    );

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "firebase:firebase-basics",
      description: "Firebase basics",
    });
  });

  it("lists a plugin that keeps its one skill directly in skills/", async () => {
    // Probed 2026-09-23: `/android-cli-plugin:..:android-cli` expanded, while the same name without
    // the `..` did not, so the placeholder belongs in the published name.
    const path = join(home, ".gemini", "config", "plugins", "android-cli-plugin", "skills");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), skill("name: android-cli\ndescription: Android CLI"), "utf8");

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "android-cli-plugin:..:android-cli",
      description: "Android CLI",
    });
  });

  it("lists the skills the CLI ships with", async () => {
    // Probed 2026-09-23: `/migrate-workflows` expanded from the CLI's own unpacked skills.
    const path = join(home, ".gemini", "antigravity-cli", "builtin", "skills", "migrate-workflows");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      skill("name: migrate-workflows\ndescription: Migrate legacy workflows"),
      "utf8",
    );

    expect((await discoverCommands(workspace)).commands.at(-1)).toEqual({
      name: "migrate-workflows",
      description: "Migrate legacy workflows",
    });
  });

  it("lists the skills of the CLI's global roots", async () => {
    // Probed 2026-09-23 (CLI 1.2.9): a skill in each of the three expanded as `(skill)`, and the
    // picker shows them in the CLI's own precedence order.
    for (const [index, root] of GLOBAL_ROOTS.entries()) {
      const frontmatter = `name: global-${index}\ndescription: Global ${index}`;
      writeGlobalSkill(root, `global-${index}`, skill(frontmatter));
    }

    expect((await names()).slice(6)).toEqual(["global-0", "global-1", "global-2"]);
  });

  it("keeps the workspace copy of a name the global roots also have", async () => {
    // Probed 2026-09-23: with one name in the workspace and in every global root, the CLI expanded
    // the workspace copy — the picker must describe that same copy.
    const frontmatter = (description: string) => `name: release-notes\ndescription: ${description}`;
    writeSkill(".agents", "release-notes", skill(frontmatter("Workspace copy")));
    writeGlobalSkill(".gemini/config/skills", "release-notes", skill(frontmatter("Global copy")));
    writeGlobalSkill(".gemini/skills", "release-notes", skill(frontmatter("Legacy copy")));

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.filter((command) => command.name === "release-notes")).toEqual([
      { name: "release-notes", description: "Workspace copy" },
    ]);
  });

  it("keeps the copy from the highest global root when two of them share a name", async () => {
    for (const [index, root] of GLOBAL_ROOTS.entries()) {
      writeGlobalSkill(root, "triage", skill(`name: triage\ndescription: Root ${index}`));
    }

    const triage = (await discoverCommands(workspace)).commands.filter((command) => command.name === "triage");
    expect(triage).toEqual([{ name: "triage", description: "Root 0" }]);
  });

  it("offers every command once when a name is claimed twice", async () => {
    writeSkill(".agents", "dup", skill("name: plan\ndescription: A workspace plan"));

    const commands = (await discoverCommands(workspace)).commands;
    expect(commands.filter((command) => command.name === "plan")).toHaveLength(1);
    // The CLI's own workflow keeps the name; a workspace skill cannot shadow it.
    expect(commands[0]?.description).not.toBe("A workspace plan");
  });

  it("offers a shared-installer skill and marks it as one this plugin expands", async () => {
    // Probed 2026-09-23: the CLI reads neither `~/.agents/skills` nor `.agents/skills` under the
    // home directory, so the picker only offers this one because the plugin expands it itself.
    writeGlobalSkill(".agents/skills", "release-notes", skill("name: release-notes\ndescription: Draft notes"));

    const discovered = await discoverCommands(workspace);
    expect(discovered.commands.at(-1)).toEqual({
      name: "release-notes",
      description: "Draft notes",
    });
    expect(discovered.expanded.get("release-notes")).toEqual({
      name: "release-notes",
      description: "Draft notes",
      dir: join(home, ".agents", "skills", "release-notes"),
      path: join(home, ".agents", "skills", "release-notes", "SKILL.md"),
    });
  });

  it("leaves a shared skill to the command the CLI expands itself", async () => {
    // A name the CLI resolves on its own is the one the user gets, so the copy in the shared
    // directory is not offered and not expanded by the plugin.
    writeSkill(".agents", "release-notes", skill("name: release-notes\ndescription: Workspace copy"));
    writeGlobalSkill(".agents/skills", "release-notes", skill("name: release-notes\ndescription: Shared copy"));

    const discovered = await discoverCommands(workspace);
    expect(discovered.commands.filter((command) => command.name === "release-notes")).toEqual([
      { name: "release-notes", description: "Workspace copy" },
    ]);
    expect(discovered.expanded.has("release-notes")).toBe(false);
  });

  it("builds the turn text from the skill's body without its frontmatter", async () => {
    writeGlobalSkill(
      ".agents/skills",
      "release-notes",
      skill("name: release-notes\ndescription: Draft notes", "List the merged pull requests.\n"),
    );
    const expanded = (await discoverCommands(workspace)).expanded.get("release-notes");
    if (expanded === undefined) throw new Error("the shared skill was not discovered");

    expect(await renderSkillPrompt(expanded, "for v1.2")).toEqual({
      kind: "text",
      text:
        `[Skill: release-notes]\nList the merged pull requests.` +
        `\n\nSkill directory: ${expanded.dir} — resolve relative paths in these instructions against it.` +
        `\n\nUser request: for v1.2`,
    });
    // A command sent without arguments has no request to append.
    expect(await renderSkillPrompt(expanded, "")).toMatchObject({
      kind: "text",
      text: expect.not.stringContaining("User request:"),
    });

    rmSync(expanded.path);
    expect(await renderSkillPrompt(expanded, "for v1.2")).toMatchObject({ kind: "unreadable" });
  });
});
