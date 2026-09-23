import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSnapshotTool, readSnapshot, snapshotTarget } from "./edits";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-edits-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("snapshotTarget", () => {
  it("reads an absolute target and ignores anything else", () => {
    expect(snapshotTarget({ TargetFile: "/workspace/hello.txt" })).toBe("/workspace/hello.txt");
    expect(snapshotTarget({ AbsolutePath: "/workspace/hello.txt" })).toBe("/workspace/hello.txt");
    expect(snapshotTarget({ TargetFile: "hello.txt" })).toBeNull();
    expect(snapshotTarget({ TargetFile: "" })).toBeNull();
    expect(snapshotTarget({})).toBeNull();
    expect(snapshotTarget(undefined)).toBeNull();
  });

  it("snapshots only the tools that change a file", () => {
    for (const name of [
      "replace_file_content",
      "multi_replace_file_content",
      "sed_file",
      "write_to_file",
    ]) {
      expect(isSnapshotTool(name)).toBe(true);
    }
    expect(isSnapshotTool("view_file")).toBe(false);
    expect(isSnapshotTool("run_command")).toBe(false);
    expect(isSnapshotTool("constructor")).toBe(false);
  });
});

describe("readSnapshot", () => {
  it("reads a text file and reports a missing one as absent", async () => {
    const file = join(tempDir, "hello.txt");
    writeFileSync(file, "hello world\n");

    expect(await readSnapshot(file)).toEqual({ exists: true, text: "hello world\n" });
    // Missing is not unreadable: the caller uses this to recognise a newly created file.
    expect(await readSnapshot(join(tempDir, "gone.txt"))).toEqual({ exists: false, text: "" });
  });

  it("refuses what it cannot compare", async () => {
    const binary = join(tempDir, "image.png");
    writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(await readSnapshot(binary)).toBeNull();

    // A byte sequence that is not valid UTF-8 is not text either.
    const invalid = join(tempDir, "latin1.txt");
    writeFileSync(invalid, Buffer.from([0x68, 0x69, 0xff, 0xfe]));
    expect(await readSnapshot(invalid)).toBeNull();

    const directory = join(tempDir, "dir");
    mkdirSync(directory);
    expect(await readSnapshot(directory)).toBeNull();
  });

  it("snapshots a file at the size limit and refuses one past it", async () => {
    const atLimit = join(tempDir, "at-limit.txt");
    writeFileSync(atLimit, "a".repeat(256 * 1024));
    expect(await readSnapshot(atLimit)).toMatchObject({ exists: true });

    const overLimit = join(tempDir, "over-limit.txt");
    writeFileSync(overLimit, "a".repeat(256 * 1024 + 1));
    expect(await readSnapshot(overLimit)).toBeNull();
  });
});
