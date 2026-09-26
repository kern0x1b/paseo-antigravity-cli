/**
 * The handle Paseo keeps for a conversation, and how it is read back.
 */

import type { ProviderPersistence } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "./json";

export function persistenceFor(conversationId: string | null): ProviderPersistence {
  return { version: 1, data: { conversationId } };
}

export function readConversationId(persistence: ProviderPersistence | undefined): string | null {
  if (!persistence || persistence.version !== 1) return null;
  const data = persistence.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = (data as Record<string, JsonValue>).conversationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}
