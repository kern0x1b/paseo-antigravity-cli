import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptStore } from "./transcript";

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
});
