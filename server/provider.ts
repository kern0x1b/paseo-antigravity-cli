
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { catalogCacheKey, invalidateCatalogCache } from "./catalog";
import { createConnection } from "./connection";
import { CAPABILITIES } from "./constants";
import { sweepPluginData } from "./housekeeping";
import { cleanUpLegacyMcpEntries, sweepSessionMcpConfigs } from "./mcp";
import { liveSessions } from "./state";
import { DEFAULT_TIMING, type Timing } from "./timing";
import { attempt } from "./util";
import { type AccountConfig, DEFAULT_ACCOUNT, resolveAccountHome } from "./accounts";

export interface ProviderOptions {
  /** Overrides of the provider's waits and periods, for a caller that cannot wait seconds. */
  timing?: Partial<Timing>;
  /** Account this provider is registered for. Defaults to DEFAULT_ACCOUNT. */
  account?: AccountConfig;
}

export function createProvider(options: ProviderOptions = {}): ProviderRegistration {
  const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
  const account: AccountConfig = options.account ?? DEFAULT_ACCOUNT;
  const home = resolveAccountHome(account);
  return {
    id: account.id,
    label: account.label,
    description: "Run, monitor, and steer Antigravity sessions from Paseo",
    icon: "icon.svg",
    async getCatalogCacheKey(options) {
      // Catalog inputs carry no providerOptions, so a per-session `agyPath` cannot reach the
      // catalog; the key follows the resolved binary, its build, and the environment override.
      // `force` is the caller asking for a refresh, which the in-process cache must not answer
      // with the list it already has.
      if (options.force) invalidateCatalogCache(undefined, home);
      return catalogCacheKey(undefined, home);
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Antigravity provider requires provider protocol version 1");
      }
      // Credentials a process that died without closing its sessions left behind, and what earlier
      // versions wrote into workspaces, are taken back the first time anything connects.
      await attempt("take back the old MCP entries", () => cleanUpLegacyMcpEntries(account));
      await attempt("sweep the MCP folders", () => sweepSessionMcpConfigs(liveSessions, account));
      await attempt("sweep the plugin's data", () =>
        sweepPluginData({ account, live: liveSessions, retentionMs: timing.orphanRetentionMs }),
      );
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES), timing, account);
    },
  };
}
