import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseModels } from "./catalog";

const fakeAgy = fileURLToPath(new URL("./testing/fake-agy.mjs", import.meta.url));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "antigravity-catalog-"));
  chmodSync(fakeAgy, 0o755);
  process.env.PASEO_ANTIGRAVITY_BIN = fakeAgy;
  delete process.env.FAKE_MODELS_OK;
  delete process.env.FAKE_MODELS_LOG;
  // Each case needs a cold module cache so the model list is discovered again; the tests then use
  // dynamic imports for the same reason, since a static one would keep the first case's cache.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PASEO_ANTIGRAVITY_BIN;
  delete process.env.FAKE_MODELS_LOG;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("parseModels", () => {
  it("reads the tab separated slug and label pairs", () => {
    expect(
      parseModels("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\nfake-model-x\tFake Model X\n"),
    ).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", isDefault: true },
      { id: "fake-model-x", label: "Fake Model X", isDefault: false },
    ]);
  });

  it("skips the progress banner and any line that is not a model row", () => {
    const output = [
      "Fetching available models...",
      "",
      "   ",
      "no-tab-separator",
      "\tMissing slug",
      "missing-label\t",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "claude-opus-4-6-thinking\tDuplicate row",
      "not a valid slug!\tBad",
    ].join("\n");

    expect(parseModels(output)).toEqual([
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", isDefault: false },
    ]);
  });

  it("returns nothing for empty output so the caller can fall back", () => {
    expect(parseModels("")).toEqual([]);
    expect(parseModels("Fetching available models...\n")).toEqual([]);
  });
});

describe("catalog cache", () => {
  function modelsRuns(logPath: string): number {
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  }

  it("keys on the binary path and its modification time", async () => {
    const first = join(tempDir, "agy-a");
    const second = join(tempDir, "agy-b");
    copyFileSync(fakeAgy, first);
    copyFileSync(fakeAgy, second);
    const { catalogCacheKey } = await import("./catalog");

    const key = catalogCacheKey(first);
    expect(key).toContain(first);
    expect(catalogCacheKey(second)).not.toBe(key);

    // A CLI update rewrites the binary, so the build identity is part of the key.
    utimesSync(first, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    expect(catalogCacheKey(first)).not.toBe(key);
  });

  it("discovers models again when the binary changes, and when a caller forces it", async () => {
    process.env.FAKE_MODELS_OK = "1";
    const logPath = join(tempDir, "models.log");
    process.env.FAKE_MODELS_LOG = logPath;
    const first = join(tempDir, "agy-a");
    const second = join(tempDir, "agy-b");
    copyFileSync(fakeAgy, first);
    copyFileSync(fakeAgy, second);
    const { buildCatalog, catalogCacheKey } = await import("./catalog");

    await buildCatalog(first);
    await buildCatalog(first);
    expect(modelsRuns(logPath)).toBe(1);

    // A different binary may report a different list, so it must not be served from the cache.
    await buildCatalog(second);
    expect(modelsRuns(logPath)).toBe(2);

    const { createProvider } = await import("./provider");
    const registration = createProvider();
    expect(await registration.getCatalogCacheKey?.({ scope: "global" })).toBe(catalogCacheKey());

    // An explicit refresh bypasses our cache as well as the daemon's.
    await registration.getCatalogCacheKey?.({ scope: "global", force: true });
    await buildCatalog(second);
    expect(modelsRuns(logPath)).toBe(3);
  });
});

describe("buildCatalog", () => {
  it("uses the models reported by the CLI", async () => {
    process.env.FAKE_MODELS_OK = "1";
    const { buildCatalog } = await import("./catalog");

    const catalog = await buildCatalog();

    expect(catalog.models.map((model) => model.id)).toEqual([
      "gemini-3.8-flash-high",
      "fake-model-x",
    ]);
    expect(catalog.defaultModel).toBe("gemini-3.8-flash-high");
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["default", "accept-edits", "plan"]);
    // Effort is expressed through the model id, so there is no separate thinking-option axis.
    expect(catalog.thinkingOptions).toEqual([]);
    expect(catalog.defaultMode).toBe("default");
  });

  it("falls back to the bundled list when the CLI cannot list models", async () => {
    const { buildCatalog } = await import("./catalog");

    const catalog = await buildCatalog();

    expect(catalog.models.length).toBeGreaterThan(10);
    expect(catalog.models.map((model) => model.id)).toContain("claude-opus-4-6-thinking");
    expect(catalog.models.filter((model) => model.isDefault)).toHaveLength(1);
    // The fallback must still expose the modes the composer needs.
    expect(catalog.modes.map((mode) => mode.id)).toContain("plan");
  });
});
