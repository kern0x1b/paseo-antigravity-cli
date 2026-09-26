import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepPluginData } from "./housekeeping";
import { pluginDataDir } from "./plugindata";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 7 * DAY;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-housekeeping-"));
  process.env.PASEO_HOME = home;
});

afterEach(() => {
  delete process.env.PASEO_HOME;
  rmSync(home, { recursive: true, force: true });
});

function attachmentFolder(sessionId: string, ageMs: number): string {
  const dir = pluginDataDir("attachments", sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1.png"), "png");
  const then = new Date(Date.now() - ageMs);
  utimesSync(dir, then, then);
  return dir;
}

function schemaFile(sessionId: string, ageMs: number): string {
  const path = pluginDataDir("schemas", `${sessionId}.json`);
  mkdirSync(pluginDataDir("schemas"), { recursive: true });
  writeFileSync(path, "{}");
  const then = new Date(Date.now() - ageMs);
  utimesSync(path, then, then);
  return path;
}

describe("sweepPluginData", () => {
  it("removes the attachments and schema of a session that is gone once they are past retention", async () => {
    const attachments = attachmentFolder("orphan", RETENTION + DAY);
    const schema = schemaFile("orphan", RETENTION + DAY);

    await sweepPluginData({ live: new Set(), retentionMs: RETENTION });

    expect(existsSync(attachments)).toBe(false);
    expect(existsSync(schema)).toBe(false);
  });

  it("keeps what is younger than the retention, in case the session comes back", async () => {
    const attachments = attachmentFolder("recent", DAY);
    const schema = schemaFile("recent", DAY);

    await sweepPluginData({ live: new Set(), retentionMs: RETENTION });

    expect(existsSync(attachments)).toBe(true);
    expect(existsSync(schema)).toBe(true);
  });

  it("never touches a session that is open, however old its files are", async () => {
    const attachments = attachmentFolder("live", 30 * DAY);
    const schema = schemaFile("live", 30 * DAY);

    await sweepPluginData({ live: new Set(["live"]), retentionMs: RETENTION });

    expect(existsSync(attachments)).toBe(true);
    expect(existsSync(schema)).toBe(true);
  });

  it("matches a live session to its folder by the name the folder was given", async () => {
    const attachments = attachmentFolder("a_b", 30 * DAY);
    await sweepPluginData({ live: new Set(["a/b"]), retentionMs: RETENTION });
    expect(existsSync(attachments)).toBe(true);
  });

  it("removes a transcript with nothing in it, at any age, and keeps one that has rows", async () => {
    mkdirSync(pluginDataDir("transcripts"), { recursive: true });
    const empty = pluginDataDir("transcripts", "empty.jsonl");
    const full = pluginDataDir("transcripts", "full.jsonl");
    writeFileSync(empty, "");
    writeFileSync(full, '{"type":"assistant_message","id":"a","text":"x"}\n');

    await sweepPluginData({ live: new Set(), retentionMs: RETENTION });

    expect(existsSync(empty)).toBe(false);
    expect(existsSync(full)).toBe(true);
  });

  it("does nothing, and does not mind, when the plugin has written nothing yet", async () => {
    await expect(sweepPluginData({ live: new Set(), retentionMs: RETENTION })).resolves.toBeUndefined();
  });
});
