import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT,
  loadAccounts,
  parseAccounts,
  resolveAccountHome,
  unlockAccountKeychain,
} from "./accounts";
import { accountPluginDataDir, pluginDataDir } from "./plugindata";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "antigravity-accounts-"));
  process.env.PASEO_HOME = home;
});

afterEach(() => {
  delete process.env.PASEO_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("accounts", () => {
  it("defaults to a single antigravity-cli account with null home", () => {
    expect(DEFAULT_ACCOUNT).toEqual({
      id: "antigravity-cli",
      label: "Antigravity",
      description: "Run, monitor, and steer Antigravity sessions from Paseo",
      icon: "icon.svg",
      home: null,
    });
  });

  it("resolves account home to process.env.HOME / homedir when home is null", () => {
    expect(resolveAccountHome(DEFAULT_ACCOUNT)).toBe(process.env.HOME ?? homedir());
    expect(resolveAccountHome(null)).toBe(process.env.HOME ?? homedir());
    expect(resolveAccountHome({ ...DEFAULT_ACCOUNT, home: "/custom/work" })).toBe("/custom/work");
  });

  it("returns default account when accounts.json does not exist", () => {
    expect(loadAccounts()).toEqual([DEFAULT_ACCOUNT]);
  });

  it("parses valid accounts configuration", () => {
    const json = JSON.stringify([
      { id: "antigravity-cli", label: "Antigravity", home: null },
      { id: "antigravity-work", label: "Antigravity Work", home: "/Users/test/.antigravity-work" },
    ]);
    const accounts = parseAccounts(json);
    expect(accounts).toEqual([
      { id: "antigravity-cli", label: "Antigravity", description: undefined, home: null, icon: undefined },
      { id: "antigravity-work", label: "Antigravity Work", description: undefined, home: "/Users/test/.antigravity-work", icon: undefined },
    ]);
  });

  it("handles malformed JSON or invalid schema gracefully by returning default account", () => {
    expect(parseAccounts("not json")).toEqual([DEFAULT_ACCOUNT]);
    expect(parseAccounts("[]")).toEqual([DEFAULT_ACCOUNT]);
    expect(parseAccounts("{}")).toEqual([DEFAULT_ACCOUNT]);
    expect(parseAccounts(JSON.stringify([{ invalid: true }]))).toEqual([DEFAULT_ACCOUNT]);
  });

  it("ignores duplicate or invalid IDs", () => {
    const json = JSON.stringify([
      { id: "antigravity-cli", label: "First" },
      { id: "antigravity-cli", label: "Duplicate" },
      { id: "INVALID_UPPERCASE", label: "Bad ID" },
      { id: "antigravity-second", label: "Second" },
    ]);
    const accounts = parseAccounts(json);
    expect(accounts.map((a) => a.id)).toEqual(["antigravity-cli", "antigravity-second"]);
    expect(accounts[0]?.label).toBe("First");
  });

  it("loads accounts from accounts.json in plugin data directory", () => {
    const dir = accountPluginDataDir("antigravity-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "accounts.json"),
      JSON.stringify([
        { id: "antigravity-cli", label: "Antigravity", home: null },
        { id: "antigravity-work", label: "Work", home: "/Users/test/.antigravity-work" },
      ]),
      "utf8",
    );
    const accounts = loadAccounts();
    expect(accounts.length).toBe(2);
    expect(accounts[0]?.id).toBe("antigravity-cli");
    expect(accounts[1]?.id).toBe("antigravity-work");
    expect(accounts[1]?.home).toBe("/Users/test/.antigravity-work");
  });
});

describe("accountPluginDataDir", () => {
  it("keeps byte-for-byte compatible paths for the default account", () => {
    expect(pluginDataDir("attachments", "s1")).toBe(accountPluginDataDir("antigravity-cli", "attachments", "s1"));
    expect(accountPluginDataDir(null, "archived.json")).toBe(join(home, "plugin-data", "antigravity-cli", "archived.json"));
    expect(accountPluginDataDir(undefined, "archived.json")).toBe(join(home, "plugin-data", "antigravity-cli", "archived.json"));
  });

  it("scopes folders for custom account IDs", () => {
    expect(accountPluginDataDir("antigravity-work", "attachments", "s1")).toBe(
      join(home, "plugin-data", "antigravity-work", "attachments", "s1"),
    );
    expect(accountPluginDataDir({ id: "antigravity-work" }, "archived.json")).toBe(
      join(home, "plugin-data", "antigravity-work", "archived.json"),
    );
  });
});

describe("unlockAccountKeychain", () => {
  it("unlocks the account's own keychain with HOME pointing at the account", () => {
    const accountHome = join(home, "work");
    const keychain = join(accountHome, "Library", "Keychains", "login.keychain-db");
    mkdirSync(join(accountHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(keychain, "");
    const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];

    unlockAccountKeychain(accountHome, (file, args, options) => {
      calls.push({ file, args, env: options.env });
    }, "darwin");

    expect(calls).toEqual([
      { file: "/usr/bin/security", args: ["unlock-keychain", "-p", "", keychain], env: expect.objectContaining({ HOME: accountHome }) },
    ]);
  });

  it("does nothing without a keychain in the account home, off macOS, or for the default account", () => {
    const calls: string[][] = [];
    const run = (_file: string, args: string[]) => {
      calls.push(args);
    };
    unlockAccountKeychain(join(home, "missing"), run, "darwin");
    const accountHome = join(home, "work");
    mkdirSync(join(accountHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(join(accountHome, "Library", "Keychains", "login.keychain-db"), "");
    unlockAccountKeychain(accountHome, run, "linux");
    unlockAccountKeychain(null, run, "darwin");
    expect(calls).toEqual([]);
  });

  it("does not throw when unlocking fails", () => {
    const accountHome = join(home, "work");
    mkdirSync(join(accountHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(join(accountHome, "Library", "Keychains", "login.keychain-db"), "");
    expect(() =>
      unlockAccountKeychain(accountHome, () => {
        throw new Error("locked");
      }, "darwin"),
    ).not.toThrow();
  });
});
