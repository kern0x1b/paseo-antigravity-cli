import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ProviderCatalog,
  ProviderMode,
  ProviderModel,
} from "@getpaseo/plugin/server/provider";
import { resolveAgyBinary } from "./agy";

const execFileAsync = promisify(execFile);

export const DEFAULT_MODEL_ID = "gemini-3.8-flash-high";
export const DEFAULT_MODE_ID = "default";

/** `default` is implicit: omitting --mode gives review-before-write behaviour. */
export const MODES: readonly ProviderMode[] = [
  { id: "default", label: "Default", description: "Review file writes before they run" },
  { id: "accept-edits", label: "Accept edits", description: "Accept file edits automatically" },
  { id: "plan", label: "Plan", description: "Plan without applying edits" },
];

/**
 * Captured from `agy models` on Antigravity CLI 1.2.9, used when live discovery is unavailable.
 * Every reasoning tier appears here as its own model, which is why the catalog exposes no
 * separate thinking-option axis.
 */
export const FALLBACK_MODELS: readonly ProviderModel[] = [
  "Gemini 3.8 Flash (High)|gemini-3.8-flash-high",
  "Gemini 3.8 Flash (Medium)|gemini-3.8-flash-medium",
  "Gemini 3.8 Flash (Low)|gemini-3.8-flash-low",
  "Gemini 3.7 Flash (High)|gemini-3.7-flash-high",
  "Gemini 3.7 Flash (Medium)|gemini-3.7-flash-medium",
  "Gemini 3.7 Flash (Low)|gemini-3.7-flash-low",
  "Gemini 3.6 Flash (High)|gemini-3.6-flash-high",
  "Gemini 3.6 Flash (Medium)|gemini-3.6-flash-medium",
  "Gemini 3.6 Flash (Low)|gemini-3.6-flash-low",
  "Gemini 3.1 Pro (High)|gemini-3.1-pro-high",
  "Gemini 3.1 Pro (Low)|gemini-3.1-pro-low",
  "Claude Sonnet 4.6 (Thinking)|claude-sonnet-4-6",
  "Claude Opus 4.6 (Thinking)|claude-opus-4-6-thinking",
  "GPT-OSS 120B (Medium)|gpt-oss-120b-medium",
].map((entry) => {
  const [label, id] = entry.split("|");
  return { id, label, isDefault: id === DEFAULT_MODEL_ID };
});

const CACHE_TTL_MS = 10 * 60 * 1000;
const MODELS_TIMEOUT_MS = 20_000;

let cache: { at: number; models: readonly ProviderModel[] } | null = null;

/**
 * Synchronous view of the last discovered list, for `session.config` where an async lookup would
 * stall the provider. The catalog request path is what refreshes the cache.
 */
export function currentModels(): readonly ProviderModel[] {
  return cache?.models ?? FALLBACK_MODELS;
}

export async function buildCatalog(binary?: string): Promise<ProviderCatalog> {
  const models = await loadModels(binary);
  return {
    models,
    modes: MODES,
    thinkingOptions: [],
    defaultModel: models.find((model) => model.id === DEFAULT_MODEL_ID)?.id ?? models[0]?.id,
    defaultMode: DEFAULT_MODE_ID,
  };
}

async function loadModels(binary?: string): Promise<readonly ProviderModel[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;

  let models: readonly ProviderModel[] = [];
  try {
    const { stdout } = await execFileAsync(resolveAgyBinary(binary), ["models"], {
      timeout: MODELS_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    models = parseModels(stdout);
  } catch (error) {
    console.error(`[antigravity] falling back to bundled model list: ${describe(error)}`);
  }

  const resolved = models.length > 0 ? models : FALLBACK_MODELS;
  cache = { at: Date.now(), models: resolved };
  return resolved;
}

/**
 * `agy models` prints a header line and then tab-separated `slug<TAB>label` rows. Anything
 * that does not match that shape is skipped, so a progress banner cannot become a model.
 */
export function parseModels(stdout: string): readonly ProviderModel[] {
  const models: ProviderModel[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const [rawId, rawLabel] = line.split("\t");
    if (rawId === undefined || rawLabel === undefined) continue;
    const id = rawId.trim();
    const label = rawLabel.trim();
    if (id.length === 0 || label.length === 0) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label, isDefault: id === DEFAULT_MODEL_ID });
  }

  return models;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
