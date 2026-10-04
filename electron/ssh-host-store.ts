// The saved ssh hosts (ssh-hosts.json) and their short history (ssh-hosts-history.jsonl) in the Aya config home.
// A host is saved when it is first used: a remote project opened, a Check, or added as a machine.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicTempPath, replaceJsonl } from "./atomic-write";
import { oneAtATime, withFileLock } from "./keyed-queue";
import { isSshTarget } from "./ssh";

export const SSH_HOSTS_FILE_NAME = "ssh-hosts.json";
export const SSH_HOSTS_HISTORY_FILE_NAME = "ssh-hosts-history.jsonl";
export const SSH_HOSTS_VERSION = 1;
export const HOST_HISTORY_MAX_LINES = 500;
/** A failed Check keeps only the start of ssh's one-line reason. */
export const HOST_WHY_MAX_CHARS = 200;
const FILE_MODE = 0o600;

/** Where a host was first used: Open project > Remote host, Settings > Machines, or `aya machines`. */
export type HostOrigin = "open-project" | "settings" | "cli";

export interface HostCheck {
  ok: boolean;
  at: string;
  why?: string;
}

export interface SavedHost {
  /** As typed the first time (alias or user@host); later spellings in another case match it. */
  target: string;
  addedAt: string;
  addedFrom: HostOrigin;
  lastUsedAt?: string;
  lastUsedFor?: "project" | "check";
  lastCheck?: HostCheck;
}

export type HostEventKind = "added" | "removed" | "connected" | "check-failed";

export interface HostEvent {
  at: string;
  target: string;
  event: HostEventKind;
  from?: HostOrigin;
  project?: string;
  machine?: string;
  why?: string;
}

/** What happened to a host; nothing here can hold a password, a key or a command's output. */
export type HostUse =
  | { kind: "project"; project: string }
  | { kind: "check"; ok: boolean; why?: string | null }
  | { kind: "machine-added"; machine: string }
  | { kind: "machine-removed"; machine: string };

const hostsFile = (ayaHome: string) => path.join(ayaHome, SSH_HOSTS_FILE_NAME);
const historyFile = (ayaHome: string) => path.join(ayaHome, SSH_HOSTS_HISTORY_FILE_NAME);
const ORIGINS: HostOrigin[] = ["open-project", "settings", "cli"];

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isSavedHost(v: unknown): v is SavedHost {
  const h = v as Record<string, unknown> | null;
  return typeof h === "object" && h !== null && typeof h.target === "string" && isSshTarget(h.target) && typeof h.addedAt === "string" && ORIGINS.includes(h.addedFrom as HostOrigin);
}

function parseHosts(text: string | null, file: string): SavedHost[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON; nothing was changed, fix or move it`);
  }
  const p = parsed as { version?: unknown; hosts?: unknown } | null;
  if (p?.version !== SSH_HOSTS_VERSION) throw new Error(`${file} has version ${p?.version}, this Aya reads version ${SSH_HOSTS_VERSION}; it was left as it is`);
  if (!Array.isArray(p.hosts) || !p.hosts.every(isSavedHost)) throw new Error(`${file} is not a host list this Aya can read; nothing was changed, fix or move it`);
  return p.hosts;
}

export async function loadSavedHosts(ayaHome: string): Promise<SavedHost[]> {
  return parseHosts(await readText(hostsFile(ayaHome)), hostsFile(ayaHome));
}

/** Oldest first; a torn or hand-edited line is skipped. */
export async function readHostHistory(ayaHome: string): Promise<HostEvent[]> {
  const text = (await readText(historyFile(ayaHome))) ?? "";
  return text.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line) as HostEvent;
      return typeof e?.at === "string" && typeof e.target === "string" && typeof e.event === "string" ? [e] : [];
    } catch {
      return [];
    }
  });
}

const queue = oneAtATime();

const oneLine = (why: string | null | undefined) => (why ? why.replace(/\s+/g, " ").trim().slice(0, HOST_WHY_MAX_CHARS) : undefined);

/** Saves the host on its first use and records this one; one change at a time across processes, as machines.json. */
export function recordHostUse(ayaHome: string, target: string, from: HostOrigin, use: HostUse, now = new Date()): Promise<void> {
  const t = target.trim();
  if (!isSshTarget(t)) return Promise.resolve();
  const file = hostsFile(ayaHome);
  return queue(file, () =>
    withFileLock(`${file}.lock`, async () => {
      const hosts = parseHosts(await readText(file), file);
      const at = now.toISOString();
      const events: HostEvent[] = [];
      let host = hosts.find((h) => h.target.toLowerCase() === t.toLowerCase());
      // A removal is history only: it saves no host that was never used.
      if (!host && use.kind !== "machine-removed") {
        host = { target: t, addedAt: at, addedFrom: from };
        hosts.push(host);
        events.push({ at, target: host.target, event: "added", from });
      }
      const name = host?.target ?? t;
      if (use.kind === "project") {
        host!.lastUsedAt = at;
        host!.lastUsedFor = "project";
        events.push({ at, target: name, event: "connected", from, project: use.project });
      } else if (use.kind === "check") {
        const why = use.ok ? undefined : oneLine(use.why) ?? "unreachable";
        host!.lastUsedAt = at;
        host!.lastUsedFor = "check";
        host!.lastCheck = { ok: use.ok, at, ...(why ? { why } : {}) };
        events.push({ at, target: name, event: use.ok ? "connected" : "check-failed", from, ...(why ? { why } : {}) });
      } else if (use.kind === "machine-added") {
        if (events.length === 0) events.push({ at, target: name, event: "added", from, machine: use.machine });
        else events[0].machine = use.machine;
      } else {
        events.push({ at, target: name, event: "removed", from, machine: use.machine });
      }
      if (host) {
        const staged = atomicTempPath(file);
        try {
          await fs.writeFile(staged, `${JSON.stringify({ version: SSH_HOSTS_VERSION, hosts }, null, 2)}\n`, { mode: FILE_MODE });
          await fs.rename(staged, file);
        } finally {
          await fs.rm(staged, { force: true });
        }
      }
      await appendHistory(ayaHome, events);
    }),
  );
}

async function appendHistory(ayaHome: string, events: HostEvent[]): Promise<void> {
  if (events.length === 0) return;
  const file = historyFile(ayaHome);
  const fresh = events.map((e) => JSON.stringify(e));
  const kept = ((await readText(file)) ?? "").split("\n").filter(Boolean);
  if (kept.length + fresh.length > HOST_HISTORY_MAX_LINES) {
    await replaceJsonl(file, [...kept, ...fresh].slice(-HOST_HISTORY_MAX_LINES), FILE_MODE);
  } else {
    await fs.appendFile(file, fresh.map((l) => `${l}\n`).join(""), { mode: FILE_MODE });
  }
}
