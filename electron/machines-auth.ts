// Full secrets never enter Machine, MachineView, setup, JSON status, command arguments or replies.
import { promises as fs, constants } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";

export const MACHINES_AUTH_FILE = "machines-auth.json";
interface Entry { id: string; baseUrl: string; token: string }

export function validateMachineToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !token || token.length > 4096 || /[\u0000-\u0020\u007f-\u009f]/.test(token)) throw new Error("API token must be one non-empty line, at most 4096 characters");
}

async function readEntries(ayaHome: string): Promise<Entry[]> {
  let handle;
  try {
    handle = await fs.open(path.join(ayaHome, MACHINES_AUTH_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1_000_000) throw new Error("invalid auth file");
    const data = JSON.parse(await handle.readFile("utf8"));
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("invalid auth file");
    for (const e of data.entries) {
      if (!e || typeof e.id !== "string" || typeof e.baseUrl !== "string") throw new Error("invalid auth entry");
      validateMachineToken(e.token);
    }
    return data.entries;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Machine API credentials could not be read; check the private credentials file and its permissions");
  } finally { await handle?.close(); }
}

export async function machineToken(ayaHome: string, id: string, baseUrl: string): Promise<string | null> {
  return (await readEntries(ayaHome)).find((e) => e.id === id && e.baseUrl === baseUrl)?.token ?? null;
}

/** Desktop settings only. The fixed mask conceals length; short tokens reveal no characters. */
export function savedTokenPreview(token: string): string {
  const characters = Array.from(token);
  return (characters.length >= 8 ? characters.slice(0, 4).join("") : "") + "••••••••";
}

/** Called under the registry queue, shared by UI and CLI changes. A new URL never inherits an old URL's token. */
export async function saveMachineToken(ayaHome: string, id: string, baseUrl: string | null, token?: string, clear = false): Promise<void> {
  if (token !== undefined) validateMachineToken(token);
  const entries = await readEntries(ayaHome);
  const kept = token === undefined && !clear && baseUrl ? entries.find((e) => e.id === id && e.baseUrl === baseUrl) : undefined;
  const next = entries.filter((e) => e.id !== id);
  if (token !== undefined && baseUrl) next.push({ id, baseUrl, token });
  else if (kept) next.push(kept);
  try {
    await writeFileAtomic(path.join(ayaHome, MACHINES_AUTH_FILE), JSON.stringify({ version: 1, entries: next }) + "\n", 0o600);
  } catch { throw new Error("Machine API credentials could not be saved"); }
}
