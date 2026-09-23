import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
  // Each case needs a cold module cache so the model list is discovered again.
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PASEO_ANTIGRAVITY_BIN;
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
