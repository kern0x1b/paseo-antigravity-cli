import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider());
  return () => {};
}
