/**
 * Small helpers with no knowledge of sessions: error text, JSON conversion, and safe fire-and-
 * forget.
 */

import type { ProviderError } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./json";

export function toErrorJson(error: ProviderError): JsonValue {
  return {
    message: error.message,
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.diagnostic !== undefined ? { diagnostic: error.diagnostic } : {}),
  };
}

export function toJson(value: Record<string, unknown>): JsonValue {
  return structuredClone(value) as JsonValue;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lets work nobody waits for run, with its failure logged: a rejection left on a promise that is
 * not awaited is an unhandled rejection in the plugin host.
 */
export function runInBackground(label: string, work: Promise<unknown>): void {
  work.catch((error: unknown) => console.error(`[antigravity] could not ${label}: ${describe(error)}`));
}

/** Runs one step of a teardown so that its failure cannot skip the steps after it. */
export async function attempt(label: string, work: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[antigravity] could not ${label}: ${describe(error)}`);
  }
}
