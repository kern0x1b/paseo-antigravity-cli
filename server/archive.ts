import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pluginDataDir } from "./plugindata";

/**
 * Which conversations Paseo has archived. Antigravity has no archive of its own — its conversation
 * index only grows — so the plugin keeps the list, and leaves an archived conversation out of what
 * it offers for import: a conversation that already is (or was) a Paseo agent would otherwise come
 * back as a second one. Nothing of the conversation itself is touched, and the timeline the plugin
 * stored for it stays, so unarchiving brings back exactly what archiving hid.
 */

const FILE = "archived.json";

interface ArchiveFile {
  version: 1;
  conversations: string[];
}

/** The ids of every archived conversation. A file that cannot be read means none are. */
export async function archivedConversations(): Promise<Set<string>> {
  try {
    const decoded: unknown = JSON.parse(await readFile(pluginDataDir(FILE), "utf8"));
    if (typeof decoded !== "object" || decoded === null) return new Set();
    const list = (decoded as { conversations?: unknown }).conversations;
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export async function archiveConversation(conversationId: string): Promise<void> {
  await change((archived) => archived.add(conversationId));
}

export async function unarchiveConversation(conversationId: string): Promise<void> {
  await change((archived) => archived.delete(conversationId));
}

/** Read-modify-write one at a time: two requests arriving together must not drop each other's. */
let pending: Promise<unknown> = Promise.resolve();

function change(edit: (archived: Set<string>) => unknown): Promise<void> {
  const run = pending.then(async () => {
    const archived = await archivedConversations();
    edit(archived);
    await save(archived);
  });
  pending = run.catch(() => undefined);
  return run;
}

async function save(archived: ReadonlySet<string>): Promise<void> {
  const path = pluginDataDir(FILE);
  const body: ArchiveFile = { version: 1, conversations: [...archived].sort() };
  const temp = `${path}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
