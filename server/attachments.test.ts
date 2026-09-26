import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAttachment } from "./attachments";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-attachments-"));
  process.env.PASEO_HOME = home;
});

afterEach(() => {
  delete process.env.PASEO_HOME;
  rmSync(home, { recursive: true, force: true });
});

const base64 = (bytes: number): string => Buffer.alloc(bytes, 1).toString("base64");

describe("writeAttachment", () => {
  it("writes an image the user alone can read", async () => {
    const path = await writeAttachment("s1", 1, base64(10), "image/png");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("refuses an image past the size limit and writes nothing", async () => {
    await expect(writeAttachment("s1", 1, base64(2_000), "image/png", 1_000)).rejects.toThrow(/larger than/);
    expect(existsSync(join(home, "plugin-data", "antigravity-cli", "attachments", "s1", "1.png"))).toBe(false);
  });

  it("accepts an image exactly at the limit", async () => {
    const path = await writeAttachment("s1", 1, base64(1_000), "image/png", 1_000);
    expect(existsSync(path)).toBe(true);
  });
});
