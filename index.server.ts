import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadAccounts } from "./server/accounts";
import { createProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  const accounts = loadAccounts();
  for (const account of accounts) {
    server.registerProvider(createProvider({ account }));
  }
  return () => {};
}

