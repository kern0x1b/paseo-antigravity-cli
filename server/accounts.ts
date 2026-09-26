import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROVIDER_ID } from "./constants";
import { accountPluginDataDir } from "./plugindata";
import { describe } from "./util";

export interface AccountConfig {
  id: string;
  label: string;
  description?: string;
  home: string | null;
  icon?: string;
}

export const DEFAULT_ACCOUNT: AccountConfig = {
  id: PROVIDER_ID,
  label: "Antigravity",
  description: "Run, monitor, and steer Antigravity sessions from Paseo",
  icon: "icon.svg",
  home: null,
};

export function resolveAccountHome(account?: AccountConfig | null): string {
  if (account?.home) return account.home;
  return process.env.HOME ?? homedir();
}

/** Path to accounts.json in the plugin's primary data directory. */
export function accountsFilePath(): string {
  return accountPluginDataDir(PROVIDER_ID, "accounts.json");
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;

export function parseAccounts(raw: string): AccountConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`[antigravity] accounts file is not valid JSON: ${describe(error)}`);
    return [DEFAULT_ACCOUNT];
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [DEFAULT_ACCOUNT];
  }

  const accounts: AccountConfig[] = [];
  const seenIds = new Set<string>();

  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rawId = (item as Record<string, unknown>).id;
    if (typeof rawId !== "string") continue;
    const id = rawId.trim();
    if (!PROVIDER_ID_PATTERN.test(id)) {
      console.error(`[antigravity] ignoring account with invalid id: "${id}"`);
      continue;
    }
    if (seenIds.has(id)) {
      console.error(`[antigravity] ignoring duplicate account id: "${id}"`);
      continue;
    }
    seenIds.add(id);

    const rawLabel = (item as Record<string, unknown>).label;
    const label = typeof rawLabel === "string" && rawLabel.trim().length > 0 ? rawLabel.trim() : id;

    const rawDesc = (item as Record<string, unknown>).description;
    const description = typeof rawDesc === "string" && rawDesc.trim().length > 0 ? rawDesc.trim() : undefined;

    const rawHome = (item as Record<string, unknown>).home;
    const home = typeof rawHome === "string" && rawHome.trim().length > 0 ? rawHome.trim() : null;

    const rawIcon = (item as Record<string, unknown>).icon;
    const icon = typeof rawIcon === "string" && rawIcon.trim().length > 0 ? rawIcon.trim() : undefined;

    accounts.push({
      id,
      label,
      description,
      home,
      icon,
    });
  }

  return accounts.length > 0 ? accounts : [DEFAULT_ACCOUNT];
}

export function loadAccounts(customPath?: string): AccountConfig[] {
  const filePath = customPath ?? accountsFilePath();
  try {
    if (!existsSync(filePath)) {
      return [DEFAULT_ACCOUNT];
    }
    const raw = readFileSync(filePath, "utf8");
    return parseAccounts(raw);
  } catch (error) {
    console.error(`[antigravity] failed to read accounts from ${filePath}: ${describe(error)}`);
    return [DEFAULT_ACCOUNT];
  }
}

type RunFile = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => unknown;

/**
 * An account with its own home keeps its credentials in its own keychain there, created by that
 * account's login script with an empty password. macOS locks it again after a restart, and agy
 * cannot read its token from a locked keychain, so it is unlocked before agy starts. The owner's
 * own keychains are never touched: `security` runs with HOME pointing at the account.
 */
export function unlockAccountKeychain(
  accountHome: string | null,
  run: RunFile = (file, args, options) => execFileSync(file, args, { ...options, stdio: "ignore", timeout: 5000 }),
  platform: NodeJS.Platform = process.platform,
): void {
  if (!accountHome || platform !== "darwin") return;
  const keychain = join(accountHome, "Library", "Keychains", "login.keychain-db");
  if (!existsSync(keychain)) return;
  try {
    run("/usr/bin/security", ["unlock-keychain", "-p", "", keychain], { env: { ...process.env, HOME: accountHome } });
  } catch (error) {
    console.error(`[antigravity] could not unlock the keychain of ${accountHome}: ${describe(error)}`);
  }
}
