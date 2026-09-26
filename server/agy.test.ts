import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgyProcess, resolveAgyBinary } from "./agy";
import type { AgyEvent } from "./protocol";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-agy-"));
  chmodSync(fakeAgy, 0o755);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AgyProcess", () => {
  it("reports a closed stdin instead of raising an unhandled error, then refuses turns", async () => {
    const ready = Promise.withResolvers<void>();
    const reported = Promise.withResolvers<string>();
    const process = new AgyProcess(
      { cwd: tempDir, skipPermissions: false, binary: fakeAgy, env: { FAKE_SCENARIO: "stdin-closed" } },
      {
        onEvent: (event: AgyEvent) => {
          if (event.kind === "init") ready.resolve();
        },
        onStderr: (line) => reported.resolve(line),
        onExit: () => {},
      },
    );
    process.start();
    // The child closed its stdin before reporting init, so both writes below hit a dead pipe.
    await ready.promise;

    await expect(process.writeTurn("hello")).rejects.toThrow(/EPIPE/);
    expect(await reported.promise).toContain("EPIPE");
    await expect(process.writeTurn("again")).rejects.toThrow(/stdin is closed/);

    await process.dispose();
  });
  /** Waits for a file the fake writes, which is how a test learns a process got that far. */
  async function fileContent(path: string): Promise<string> {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return readFileSync(path, "utf8");
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("stops what the CLI started as well as the CLI, when it is disposed", async () => {
    const childPidFile = join(tempDir, "child.pid");
    const process_ = new AgyProcess(
      { cwd: tempDir, skipPermissions: false, binary: fakeAgy, env: { FAKE_SCENARIO: "child", FAKE_CHILD_PID_FILE: childPidFile } },
      { onEvent: () => {}, onStderr: () => {}, onExit: () => {} },
    );
    process_.start();
    await process_.writeTurn("go");
    const childPid = Number(await fileContent(childPidFile));
    try {
      expect(alive(childPid)).toBe(true);
      await process_.dispose();
      const deadline = Date.now() + 3_000;
      while (alive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alive(childPid)).toBe(false);
    } finally {
      if (alive(childPid)) process.kill(childPid, "SIGKILL");
    }
  });

  it("reports the exit even when something the CLI started still holds its output open", async () => {
    const exited = Promise.withResolvers<number>();
    const started = Date.now();
    const process_ = new AgyProcess(
      {
        cwd: tempDir,
        skipPermissions: false,
        binary: fakeAgy,
        env: { FAKE_SCENARIO: "grandchild-pipe" },
        drainGraceMs: 200,
      },
      { onEvent: () => {}, onStderr: () => {}, onExit: () => exited.resolve(Date.now() - started) },
    );
    process_.start();
    await process_.writeTurn("go");
    // The grandchild keeps the pipe open for four seconds.
    expect(await exited.promise).toBeLessThan(2_500);
    await process_.dispose();
  });
});

describe("resolveAgyBinary", () => {
  it("finds agy where Homebrew puts it, which a daemon started from an app may not have on its PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "antigravity-bin-"));
    try {
      const brew = join(dir, "homebrew", "bin");
      mkdirSync(brew, { recursive: true });
      writeFileSync(join(brew, "agy"), "");
      const missing = join(dir, "local", "bin");
      expect(resolveAgyBinary(undefined, [missing, brew])).toBe(join(brew, "agy"));
      expect(resolveAgyBinary(undefined, [missing])).toBe("agy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers an explicit path over any directory it knows", () => {
    expect(resolveAgyBinary("/custom/agy", [tmpdir()])).toBe("/custom/agy");
  });
});
