import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ITEMS, TranscriptStore } from "./transcript";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "antigravity-transcript-"));
  homes.push(home);
  process.env.PASEO_HOME = home;
  return home;
}

function transcriptFile(home: string, conversationId: string): string {
  return join(home, "plugin-data", "antigravity-cli", "transcripts", `${conversationId}.jsonl`);
}

afterEach(() => {
  delete process.env.PASEO_HOME;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("TranscriptStore", () => {
  it("keeps writing to the home it was created under", async () => {
    const first = makeHome();
    const store = new TranscriptStore("conv-1");
    store.upsert({ type: "assistant_message", id: "a1", text: "hello" });

    // Writes are debounced, so a store can outlive the session that created it. Resolving the path
    // per write would file its rows under whatever home is set by then, which is how one test's
    // transcript used to overwrite the next one's.
    const second = makeHome();
    await store.flush();

    expect(JSON.parse(readFileSync(transcriptFile(first, "conv-1"), "utf8").trim())).toMatchObject({
      id: "a1",
      text: "hello",
    });
    expect(existsSync(transcriptFile(second, "conv-1"))).toBe(false);
  });

  it("replaces the file instead of rewriting it in place, so a crash cannot leave half of one", async () => {
    const home = makeHome();
    const store = new TranscriptStore("conv-2");
    store.upsert({ type: "assistant_message", id: "a1", text: "one" });
    await store.flush();
    const before = statSync(transcriptFile(home, "conv-2")).ino;

    store.upsert({ type: "assistant_message", id: "a2", text: "two" });
    await store.flush();

    expect(statSync(transcriptFile(home, "conv-2")).ino).not.toBe(before);
    expect(readdirSync(join(home, "plugin-data", "antigravity-cli", "transcripts"))).toEqual(["conv-2.jsonl"]);
    expect(readFileSync(transcriptFile(home, "conv-2"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("keeps a conversation's rows readable by the user alone", async () => {
    const home = makeHome();
    const store = new TranscriptStore("conv-3");
    store.upsert({ type: "user_message", id: "u1", text: "a private question" });
    await store.flush();
    expect(statSync(transcriptFile(home, "conv-3")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "plugin-data", "antigravity-cli", "transcripts")).mode & 0o777).toBe(0o700);
  });

  it("says when it had to drop the oldest rows to stay within its limit", async () => {
    makeHome();
    const store = new TranscriptStore("conv-4");
    for (let index = 0; index < MAX_ITEMS; index += 1) {
      store.upsert({ type: "assistant_message", id: `a${index}`, text: "x" });
    }
    expect(store.truncated).toBe(false);
    store.upsert({ type: "assistant_message", id: "one-more", text: "x" });
    expect(store.truncated).toBe(true);
    expect(store.list()).toHaveLength(MAX_ITEMS);
    await store.flush();

    // The fact outlives the process: a store loaded from what was written still knows.
    const loaded = await TranscriptStore.load("conv-4");
    expect(loaded.truncated).toBe(true);
    expect(loaded.list()).toHaveLength(MAX_ITEMS);
  });

  it("does not report a store that was never over its limit as truncated", async () => {
    makeHome();
    const store = new TranscriptStore("conv-5");
    store.upsert({ type: "assistant_message", id: "a1", text: "x" });
    await store.flush();
    expect((await TranscriptStore.load("conv-5")).truncated).toBe(false);
  });

  it("ignores a torn last line and keeps the rows before it", async () => {
    const home = makeHome();
    const store = new TranscriptStore("conv-6");
    store.upsert({ type: "assistant_message", id: "a1", text: "kept" });
    await store.flush();
    writeFileSync(transcriptFile(home, "conv-6"), `${readFileSync(transcriptFile(home, "conv-6"), "utf8")}{"id":"torn`);
    expect((await TranscriptStore.load("conv-6")).list()).toMatchObject([{ id: "a1", text: "kept" }]);
  });
});
