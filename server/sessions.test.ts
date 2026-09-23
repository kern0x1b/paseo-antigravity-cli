import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listConversations } from "./sessions";
import { writeConversationDb, type ConversationFixture } from "./testing/conversation-db";

const originalHome = process.env.HOME;

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-sessions-"));
  cwd = join(home, "workspace");
  mkdirSync(cwd, { recursive: true });
  // The CLI's index lives under the home directory, which is how a test repoints it.
  process.env.HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function conversation(overrides: Partial<ConversationFixture> = {}): ConversationFixture {
  return {
    conversationId: "11111111-1111-1111-1111-111111111111",
    title: "Replace Word In File",
    preview: "In hello.txt change the word hello to bye.",
    lastModifiedTime: "2026-09-23 13:31:32.28859+00:00",
    workspacePaths: [cwd],
    ...overrides,
  };
}

describe("listConversations", () => {
  it("lists the newest conversation first with its title, preview and timestamp", () => {
    writeConversationDb(home, [
      conversation({ conversationId: "older", lastModifiedTime: "2026-09-23 09:00:00+00:00" }),
      conversation({
        conversationId: "newest",
        title: "",
        preview: "Explain the streaming protocol",
        lastModifiedTime: "2026-09-23 15:45:49.636929+00:00",
      }),
    ]);

    expect(listConversations({})).toEqual([
      {
        persistence: { version: 1, data: { conversationId: "newest" } },
        cwd,
        description: "Explain the streaming protocol",
        updatedAt: "2026-09-23T15:45:49.636Z",
      },
      {
        persistence: { version: 1, data: { conversationId: "older" } },
        cwd,
        title: "Replace Word In File",
        description: "In hello.txt change the word hello to bye.",
        updatedAt: "2026-09-23T09:00:00.000Z",
      },
    ]);
  });

  it("keeps only the conversations of the requested workspace", () => {
    const other = join(home, "other-workspace");
    mkdirSync(other, { recursive: true });
    writeConversationDb(home, [
      conversation({ conversationId: "here" }),
      conversation({ conversationId: "elsewhere", workspacePaths: [other] }),
      // A conversation with no workspace cannot belong to any workspace request.
      conversation({ conversationId: "orphan", workspacePaths: [] }),
      // Subagent runs are not conversations a user can open.
      conversation({ conversationId: "subagent", parentConversationId: "here" }),
    ]);

    expect(listConversations({ cwd }).map((session) => session.persistence.data)).toEqual([
      { conversationId: "here" },
    ]);
    // Without a cwd filter the workspace-less one is still listed.
    expect(listConversations({}).map((session) => session.persistence.data)).toEqual([
      { conversationId: "here" },
      { conversationId: "elsewhere" },
      { conversationId: "orphan" },
    ]);
  });

  it("filters by a case-insensitive substring of the title or the preview", () => {
    writeConversationDb(home, [
      conversation({ conversationId: "a", title: "Fix the flaky test" }),
      conversation({ conversationId: "b", title: "Something else", preview: "The FLAKY part" }),
      conversation({ conversationId: "c", title: "Unrelated", preview: "nothing to match" }),
    ]);

    expect(listConversations({ query: "flaky" }).map((session) => session.persistence.data)).toEqual([
      { conversationId: "a" },
      { conversationId: "b" },
    ]);
    expect(listConversations({ query: "no such text" })).toEqual([]);
  });

  it("honors the limit", () => {
    writeConversationDb(home, [
      conversation({ conversationId: "one", lastModifiedTime: "2026-09-23 12:00:01+00:00" }),
      conversation({ conversationId: "two", lastModifiedTime: "2026-09-23 12:00:02+00:00" }),
      conversation({ conversationId: "three", lastModifiedTime: "2026-09-23 12:00:03+00:00" }),
    ]);

    expect(listConversations({ limit: 2 }).map((session) => session.persistence.data)).toEqual([
      { conversationId: "three" },
      { conversationId: "two" },
    ]);
  });

  it("returns nothing when the database is missing", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({ cwd })).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("could not read Antigravity conversations"),
    );
  });

  it("returns nothing when the database is corrupt", () => {
    const path = writeConversationDb(home, [conversation()]);
    writeFileSync(path, "this is not a database");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({ cwd })).toEqual([]);
    expect(logged).toHaveBeenCalled();
  });

  it("returns nothing when the table has drifted", () => {
    // A future agy could rename the table; an empty list is the only sane answer.
    const path = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("create table something_else (id text)");
    db.close();
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(listConversations({})).toEqual([]);
  });

  it("leaves the database untouched", () => {
    const path = writeConversationDb(home, [conversation()]);
    const before = readDatabaseBytes(path);

    listConversations({ cwd });

    expect(readDatabaseBytes(path)).toEqual(before);
  });
});

/** Raw file bytes, plus the WAL if the CLI keeps one: reading through sqlite could itself write. */
function readDatabaseBytes(path: string): Buffer {
  const wal = `${path}-wal`;
  return Buffer.concat([readFileSync(path), existsSync(wal) ? readFileSync(wal) : Buffer.alloc(0)]);
}
