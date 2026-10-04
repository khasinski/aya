// `aya machines`: the registry, the one-sentence draft and the status table (docs/machines.md, step 1).
// Read-only towards every machine: nothing here loads, unloads or calls a model.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicTempPath } from "./atomic-write";
import { oneAtATime, withFileLock } from "./keyed-queue";
import { probeMachine, type MachineStatus, type Reach } from "./machines-probe";
import { isSshTarget } from "./ssh";
import { loadSavedHosts, readHostHistory, recordHostUse, type HostEvent, type HostOrigin, type HostUse } from "./ssh-host-store";
import { mergeKnownHosts, sshHostAliases, type HostPane, type KnownHost } from "./ssh-hosts";
import { singleFlight } from "./single-flight";

export const MACHINES_FILE_NAME = "machines.json";
export const MACHINES_VERSION = 1;
export const DEFAULT_OLLAMA_PORT = 11434;
export const STATUS_CACHE_MS = 3_000;
const MACHINES_FILE_MODE = 0o600;
const ID_PATTERN = /^[a-z0-9-]+$/;
const PURPOSE_MAX_CHARS = 200;
const LOCAL_WORDS = new Set(["local"]);
const LOCAL_PHRASES = [/\bthis machine\b/i];
const LOCAL_PHRASE_WORD = "this-machine";
/** Words that start a clause like a host name would ("it is ..."), never a host. */
const NOT_HOSTS = new Set(["it", "this", "that", "there", "which", "ollama", "ssh", "and", "also", "my", "the"]);
/** Words people use for a machine that say nothing about how to reach it: asked, never taken as local. */
const AMBIGUOUS_WORDS = new Set(["laptop", "notebook", "mac", "macbook", "imac", "desktop", "workstation", "pc", "computer"]);

export interface Occupancy {
  by: string;
  pane?: string;
  purpose: string;
  since: string;
}

export interface Machine {
  id: string;
  label: string;
  reach: Reach;
  ollama: { port: number };
  occupancy?: Occupancy;
}

export interface Registry {
  version: number;
  machines: Machine[];
}

export interface MachinesDeps {
  /** The Aya config home holding machines.json. */
  ayaHome: string;
  /** The user's home, for ~/.ssh/config. */
  userHome: string;
  /** Remote projects, whose ssh targets are known hosts too, with their panes. */
  listRemoteProjects?: () => Promise<{ name: string; sshTarget: string; panes?: Omit<HostPane, "project">[] }[]>;
  /** Where this caller's first use of a host is recorded as coming from; without it nothing is recorded. */
  origin?: HostOrigin;
  probe?: typeof probeMachine;
  now?: () => Date;
  /** Test seam: runs after the new registry is staged, just before the last check and the rename. */
  beforeCommit?: () => Promise<void>;
  /** Aya's own Add / Cancel dialog with the probe results; without it nothing can be added. It closes on `signal`. */
  confirmAdd?: (ask: AddAsk, signal?: AbortSignal) => Promise<boolean>;
  confirmRemove?: (id: string, signal?: AbortSignal) => Promise<boolean>;
}

/** What the user is asked to add, with what a read-only probe found on each machine. */
export interface AddAsk {
  machines: (DraftMachine & { status: MachineStatus })[];
  /** The pane whose agent asked, when one did. */
  pane?: string;
}

const registryFile = (deps: MachinesDeps) => path.join(deps.ayaHome, MACHINES_FILE_NAME);

/** Why `value` is not a registry this Aya reads, or null; a file that fails is never rewritten. */
function registryProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "it is not a JSON object";
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.machines)) return "machines is not a list";
  const ids = new Set<string>();
  for (const [i, m] of (r.machines as unknown[]).entries()) {
    const at = `machine ${i + 1}`;
    if (typeof m !== "object" || m === null) return `${at} is not an object`;
    const machine = m as Record<string, unknown>;
    if (typeof machine.id !== "string" || !ID_PATTERN.test(machine.id)) return `${at}: id must use a-z, 0-9 and -`;
    if (ids.has(machine.id)) return `${at}: id "${machine.id}" is used twice`;
    ids.add(machine.id);
    if (typeof machine.label !== "string") return `${at}: label is not text`;
    const reach = machine.reach as { ssh?: unknown } | string | undefined;
    const reachOk = reach === "local" || (typeof reach === "object" && reach !== null && typeof reach.ssh === "string" && isSshTarget(reach.ssh));
    if (!reachOk) return `${at}: reach must be "local" or {"ssh": "<alias or user@host>"}`;
    const port = (machine.ollama as { port?: unknown } | undefined)?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return `${at}: ollama.port is not a port number`;
    const o = machine.occupancy as Record<string, unknown> | undefined;
    if (o !== undefined && (typeof o !== "object" || o === null || typeof o.by !== "string" || typeof o.purpose !== "string" || typeof o.since !== "string")) {
      return `${at}: occupancy needs by, purpose and since`;
    }
  }
  return null;
}

async function readRegistryText(deps: MachinesDeps): Promise<string | null> {
  try {
    return await fs.readFile(registryFile(deps), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function parseRegistry(text: string | null, file: string): Registry {
  if (text === null) return { version: MACHINES_VERSION, machines: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON; nothing was changed, fix or move it`);
  }
  const version = (parsed as { version?: unknown } | null)?.version;
  if (version !== MACHINES_VERSION) {
    throw new Error(`${file} has version ${version}, this Aya reads version ${MACHINES_VERSION}; it was left as it is`);
  }
  const problem = registryProblem(parsed);
  if (problem) throw new Error(`${file} is not a registry this Aya can read (${problem}); nothing was changed, fix or move it`);
  return { version: MACHINES_VERSION, machines: (parsed as Registry).machines };
}

export async function loadRegistry(deps: MachinesDeps): Promise<Registry> {
  return parseRegistry(await readRegistryText(deps), registryFile(deps));
}

const registryQueue = oneAtATime();

/** One registry change at a time, across processes too (a lock file next to it): read, change, and rename the
 *  staged file in only if the file is still what was read, checked after staging so the gap is one rename. */
export function mutateRegistry<T>(deps: MachinesDeps, change: (registry: Registry) => T | Promise<T>): Promise<T> {
  const file = registryFile(deps);
  return registryQueue(file, () =>
    withFileLock(`${file}.lock`, async () => {
      const before = await readRegistryText(deps);
      const registry = parseRegistry(before, file);
      const result = await change(registry);
      const problem = registryProblem(registry);
      if (problem) throw new Error(`${problem}; nothing was saved`);
      const staged = atomicTempPath(file);
      try {
        await fs.writeFile(staged, `${JSON.stringify(registry, null, 2)}\n`, { mode: MACHINES_FILE_MODE });
        await deps.beforeCommit?.();
        // An editor that ignores the lock can still land between this read and the rename; nothing narrower exists on POSIX.
        if ((await readRegistryText(deps)) !== before) throw new Error(`${file} changed while this command ran; nothing was saved, run it again`);
        await fs.rename(staged, file);
      } finally {
        await fs.rm(staged, { force: true });
      }
      return result;
    }),
  );
}

// ---- known hosts ----

/** ~/.ssh/config aliases, remote project targets, added machines and saved hosts, each with its sources, current
 *  usage and newest history (electron/ssh-hosts.ts); a broken saved-hosts file only leaves those fields out. */
export async function knownHosts(deps: MachinesDeps, registry?: Registry): Promise<KnownHost[]> {
  const [aliases, remoteProjects, reg, saved, history] = await Promise.all([
    sshHostAliases(deps.userHome),
    deps.listRemoteProjects?.().catch(() => []) ?? Promise.resolve([]),
    registry ? Promise.resolve(registry) : loadRegistry(deps),
    loadSavedHosts(deps.ayaHome).catch(() => []),
    readHostHistory(deps.ayaHome).catch(() => []),
  ]);
  const machines = reg.machines.flatMap((m) => (m.reach === "local" ? [] : [{ id: m.id, ssh: m.reach.ssh, ...(m.occupancy ? { occupancy: m.occupancy } : {}) }]));
  return mergeKnownHosts({ aliases, remoteProjects, machines, saved, history });
}

/** Records a use of an ssh host for its saved entry and history; bookkeeping never fails the action it records. */
export async function noteHostUse(deps: Pick<MachinesDeps, "ayaHome" | "origin" | "now">, reach: Reach, use: HostUse): Promise<void> {
  if (reach === "local" || !deps.origin) return;
  await recordHostUse(deps.ayaHome, reach.ssh, deps.origin, use, deps.now?.() ?? new Date()).catch((err) =>
    console.warn(`[aya] could not record the use of ${reach.ssh}: ${(err as Error).message}`),
  );
}

// ---- the one-sentence draft ----

export interface DraftMachine {
  id: string;
  reach: Reach;
  port: number;
}

export interface SentenceDraft {
  machines: DraftMachine[];
  /** Words like "laptop" that could be this machine or another: asked, not drafted. */
  unclear: string[];
  /** Words used as a host name that are no known host. */
  unknown: string[];
  alreadyAdded: string[];
}

const idFor = (name: string) => name.toLowerCase().replace(/^[^@]*@/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "machine";

/** Deterministic: known hosts (aliases, user@host), `local` / "this machine", `port N` after a machine; nothing else is guessed. */
export function draftFromSentence(sentence: string, aliases: string[], registry: Registry): SentenceDraft {
  const draft: SentenceDraft = { machines: [], unclear: [], unknown: [], alreadyAdded: [] };
  const byLower = new Map(aliases.map((a) => [a.toLowerCase(), a]));
  const registered = (reach: Reach) => registry.machines.some((m) => (reach === "local" ? m.reach === "local" : m.reach !== "local" && m.reach.ssh === reach.ssh));
  // Aliases like a.b and a_b read as one id; the later one takes the next free number.
  const freeId = (base: string) => {
    const taken = (id: string) => registry.machines.some((m) => m.id === id) || draft.machines.some((m) => m.id === id);
    let id = base;
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    return id;
  };
  const add = (reach: Reach, word: string) => {
    if (registered(reach)) {
      if (!draft.alreadyAdded.includes(word)) draft.alreadyAdded.push(word);
      return;
    }
    if (draft.machines.some((m) => JSON.stringify(m.reach) === JSON.stringify(reach))) return;
    draft.machines.push({ id: freeId(reach === "local" ? "local" : idFor(reach.ssh)), reach, port: DEFAULT_OLLAMA_PORT });
  };
  // A phrase becomes one word in place, so the draft keeps the sentence's order.
  let text = sentence;
  for (const phrase of LOCAL_PHRASES) text = text.replace(new RegExp(phrase.source, "gi"), ` ${LOCAL_PHRASE_WORD} `);
  const words = text.split(/[^A-Za-z0-9._@+-]+/).map((w) => w.replace(/\.+$/, "")).filter(Boolean);
  words.forEach((word, i) => {
    const lower = word.toLowerCase();
    const prev = words[i - 1]?.toLowerCase();
    const next = words[i + 1]?.toLowerCase();
    if (lower === "port" && /^\d+$/.test(words[i + 1] ?? "")) {
      const port = Number(words[i + 1]);
      const last = draft.machines.at(-1);
      if (last && port >= 1 && port <= 65535) last.port = port;
      return;
    }
    if (byLower.has(lower)) return add({ ssh: byLower.get(lower)! }, word);
    // user@host names its own user and host, so it needs no Host block, as for a remote project.
    if (word.includes("@") && isSshTarget(word)) return add({ ssh: word }, word);
    if (lower === LOCAL_PHRASE_WORD) return add("local", "this machine");
    if (LOCAL_WORDS.has(lower)) return add("local", word);
    if (AMBIGUOUS_WORDS.has(lower)) {
      if (!draft.unclear.includes(word)) draft.unclear.push(word);
      return;
    }
    const usedAsHost = next === "is" ? i === 0 || /^(and|also|then)$/.test(prev ?? "") : prev === "ssh" || prev === "host";
    if (usedAsHost && !NOT_HOSTS.has(lower) && /^[A-Za-z][A-Za-z0-9._-]*$/.test(word) && !draft.unknown.includes(word)) draft.unknown.push(word);
  });
  return draft;
}

// ---- status ----

export interface MachineView extends Machine {
  status: MachineStatus;
}

const statusCache = new Map<string, { at: number; status: MachineStatus }>();
const inFlight = new Map<string, () => Promise<MachineStatus>>();

const probeKey = (m: Machine) => JSON.stringify([m.reach, m.ollama.port]);

/** One probe per machine in flight, shared by every caller, and reused for STATUS_CACHE_MS. */
export function machineStatus(machine: Machine, deps: MachinesDeps): Promise<MachineStatus> {
  const key = probeKey(machine);
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return Promise.resolve(cached.status);
  let run = inFlight.get(key);
  if (!run) {
    run = singleFlight(async () => {
      const status = await (deps.probe ?? probeMachine)(machine.reach, machine.ollama.port, { now: deps.now });
      statusCache.set(key, { at: Date.now(), status });
      return status;
    });
    inFlight.set(key, run);
  }
  return run();
}

/** The user's Check of a host, through the same shared, cached probe as an added machine; its result is recorded. */
export async function checkHost(reach: Reach, deps: MachinesDeps, port = DEFAULT_OLLAMA_PORT): Promise<MachineStatus> {
  const status = await machineStatus({ id: "", label: "", reach, ollama: { port } }, deps);
  await noteHostUse(deps, reach, { kind: "check", ok: status.reachable, why: status.error });
  return status;
}

/** Test-only: forget cached probes. */
export function clearMachineStatusCache(): void {
  statusCache.clear();
  inFlight.clear();
}

export async function machinesStatus(deps: MachinesDeps): Promise<{ version: number; machines: MachineView[] }> {
  const registry = await loadRegistry(deps);
  const machines = await Promise.all(registry.machines.map(async (m) => ({ ...m, status: await machineStatus(m, deps) })));
  return { version: MACHINES_VERSION, machines };
}

// ---- text ----

// GiB for memory and GPU alike, so a 24564 MiB card and 32 GB of RAM read on one scale.
const gb = (bytes: number | null) => (bytes === null ? "?" : (bytes / 2 ** 30).toFixed(1));
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 8);
const reachText = (reach: Reach) => (reach === "local" ? "local" : `ssh:${reach.ssh}`);

function hotUntil(expiresAt: string | null, pinned: boolean, now: Date): string {
  if (pinned) return "pinned";
  if (!expiresAt) return "loaded";
  const at = new Date(expiresAt);
  const min = Math.round((at.getTime() - now.getTime()) / 60_000);
  return `hot until ${at.toTimeString().slice(0, 5)} (${min >= 0 ? `${min} min` : "expired"})`;
}

export function formatMachines(views: MachineView[], now = new Date()): string {
  if (views.length === 0) return 'no machines yet; add one with aya machines add "<sentence>" or aya machines hosts\n';
  const idWidth = Math.max(...views.map((v) => v.id.length));
  const lines: string[] = [];
  for (const v of views) {
    const s = v.status;
    const pad = " ".repeat(idWidth + 2);
    const state = s.reachable ? "connected  " : "unreachable";
    if (!s.reachable) {
      lines.push(`${v.id.padEnd(idWidth)}  ${state}  ${reachText(v.reach)}  ${s.error} (checked ${clock(s.checkedAt)})`);
    } else {
      const gpu = s.gpus.length
        ? s.gpus.map((g) => `GPU ${g.utilPct ?? "?"}% ${g.memUsedMiB === null ? "?" : (g.memUsedMiB / 1024).toFixed(1)}/${g.memTotalMiB === null ? "?" : (g.memTotalMiB / 1024).toFixed(1)} GB`).join("  ")
        : "GPU n/a";
      const cpu = `CPU ${s.load1 === null ? "?" : s.load1.toFixed(1)}/${s.cpus ?? "?"}`;
      lines.push(`${v.id.padEnd(idWidth)}  ${state}  ${reachText(v.reach)}  ${gpu}  ${cpu}  mem ${gb(s.memUsedBytes)}/${gb(s.memTotalBytes)} GB`);
      const port = v.ollama.port;
      if (!s.ollama.up) lines.push(`${pad}ollama not answering on port ${port}`);
      else if (s.ollama.loaded === null) lines.push(`${pad}ollama ${s.ollama.version ?? "?"}  models: unavailable (${s.ollama.modelsError})`);
      else if (s.ollama.loaded.length === 0) lines.push(`${pad}ollama ${s.ollama.version ?? "?"}  no model loaded`);
      else {
        lines.push(`${pad}ollama ${s.ollama.version ?? "?"}`);
        for (const m of s.ollama.loaded) {
          const digest = m.digest ? ` (${m.digest.replace(/^sha256:/, "").slice(0, 7)})` : "";
          lines.push(`${pad}  ${m.name}${digest} ${hotUntil(m.expiresAt, m.pinned, now)}`);
        }
      }
      lines.push(`${pad}probe ${s.probeMs} ms (checked ${clock(s.checkedAt)})`);
    }
    if (v.occupancy) {
      const who = v.occupancy.pane ? `${v.occupancy.by} (pane "${v.occupancy.pane}")` : v.occupancy.by;
      lines.push(`${pad}occupied by ${who} since ${clock(v.occupancy.since)}: ${v.occupancy.purpose}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const ORIGIN_TEXT: Record<HostOrigin, string> = { "open-project": "Open project", settings: "Settings > Machines", cli: "aya machines" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:50" today, "3 Oct 14:50" another day. */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  const hm = at.toTimeString().slice(0, 5);
  return at.toDateString() === now.toDateString() ? hm : `${at.getDate()} ${MONTHS[at.getMonth()]} ${hm}`;
}

const paneText = (p: HostPane) => (p.role ? `${p.name} (${p.role} in team ${p.team})` : p.name);

/** The lines under a host in `aya machines hosts`: current usage, the saved entry and its newest history. */
export function hostDetailLines(h: KnownHost, now: Date): string[] {
  const used: string[] = [];
  if (h.machineId) used.push(`machine ${h.machineId}${h.occupancy ? ` (in use: ${h.occupancy.purpose}, by ${h.occupancy.by})` : ""}`);
  if (h.projects?.length) used.push(`project${h.projects.length > 1 ? "s" : ""} ${h.projects.join(", ")}`);
  if (h.panes?.length) used.push(`pane${h.panes.length > 1 ? "s" : ""} ${h.panes.map(paneText).join(", ")}`);
  const lines = [`used by: ${used.length ? used.join("; ") : "nothing in Aya now"}`];
  const s = h.saved;
  if (s) {
    const last = s.lastUsedAt ? `; last used ${whenText(s.lastUsedAt, now)} (${s.lastUsedFor === "project" ? "remote project" : "Check"})` : "";
    lines.push(`added ${whenText(s.addedAt, now)} from ${ORIGIN_TEXT[s.addedFrom]}${last}`);
    if (s.lastCheck) lines.push(`last Check ${whenText(s.lastCheck.at, now)}: ${s.lastCheck.ok ? "reachable" : `not reachable, ${s.lastCheck.why ?? "?"}`}`);
  } else {
    lines.push("not saved: listed until it is used");
  }
  for (const e of h.history ?? []) lines.push(`${whenText(e.at, now)} ${historyText(e)}`);
  return lines;
}

/** One history line without its time, for the CLI and the Settings row alike. */
export function historyText(e: HostEvent): string {
  const from = e.from ? ` from ${ORIGIN_TEXT[e.from]}` : "";
  if (e.event === "added") return `added${e.machine ? ` as machine ${e.machine}` : ""}${from}`;
  if (e.event === "removed") return `removed${e.machine ? ` machine ${e.machine}` : ""}${from}`;
  if (e.event === "connected") return `connected${e.project ? ` (remote project ${e.project})` : " (Check)"}`;
  return `Check failed: ${e.why ?? "?"}`;
}

export function formatHosts(hosts: KnownHost[], now: Date): string {
  if (hosts.length === 0) return "no known ssh hosts: no Host aliases in ~/.ssh/config, no remote projects, no machines\n";
  const width = Math.max(...hosts.map((h) => h.target.length));
  const pad = " ".repeat(width + 2);
  return hosts
    .map((h) => [`${h.target.padEnd(width)}  ${h.sources.join(", ")}${h.machineId ? "  (added)" : ""}`, ...hostDetailLines(h, now).map((l) => pad + l)].join("\n") + "\n")
    .join("");
}

function formatDraft(draft: SentenceDraft): string {
  const lines: string[] = [];
  if (draft.machines.length) {
    lines.push("Draft:");
    for (const m of draft.machines) lines.push(`  ${m.id}  ${reachText(m.reach)}  ollama port ${m.port}`);
  } else {
    lines.push("Nothing to add from that sentence.");
  }
  for (const w of draft.alreadyAdded) lines.push(`  ${w}: already added`);
  for (const w of draft.unknown) lines.push(`  ${w}: no such Host in ~/.ssh/config and no known host (aya machines hosts lists them)`);
  for (const w of draft.unclear) lines.push(`  Did you mean this machine by "${w}"? Say local to add it, or name its ssh alias.`);
  return `${lines.join("\n")}\n`;
}

// ---- the command ----

export interface MachinesRequest {
  argv: string[];
  user?: string;
}

export interface MachinesAnswer {
  output: string;
}

const USAGE =
  'usage: aya machines [--json] | hosts [--json] | add "<sentence>" | remove <id> | occupy <id> "<purpose>" | free <id>';

// One-sentence UX: the sentence and a suggestion's Add are the only ways in, so options get a pointer, not a parse.
const ADD_TAKES_A_SENTENCE = 'aya machines add takes one sentence, not options: for example aya machines add "athena", or "this machine, port 11435"; nothing was added';

const sameReach = (a: Reach, b: Reach) => (a === "local" ? b === "local" : b !== "local" && a.ssh === b.ssh);

/** Probes the draft read-only, asks the user in Aya, and saves only on the dialog's Add; the caller is never asked. */
async function addMachines(drafted: DraftMachine[], deps: MachinesDeps, pane: string | undefined, before: string, callerGone?: AbortSignal): Promise<MachinesAnswer> {
  if (!deps.confirmAdd) throw new Error("adding a machine needs the user's yes in Aya, and Aya's dialog is not available here; nothing was saved");
  const probe = deps.probe ?? probeMachine;
  const machines = await Promise.all(drafted.map(async (m) => ({ ...m, status: await probe(m.reach, m.port, { now: deps.now }) })));
  const gone = new Error("the command stopped waiting for the user's answer; nothing was added");
  if (callerGone?.aborted) throw gone;
  const yes = await deps.confirmAdd({ machines, ...(pane ? { pane } : {}) }, callerGone);
  // A dialog that cannot be closed (no parent window on macOS) still answers; that answer comes too late.
  if (callerGone?.aborted) throw gone;
  if (!yes) return { output: `${before}Not added: cancelled in Aya.\n` };
  await mutateRegistry(deps, (registry) => {
    for (const m of drafted) {
      if (registry.machines.some((x) => x.id === m.id || sameReach(x.reach, m.reach))) throw new Error(`${m.id} was already added meanwhile; nothing was saved`);
    }
    registry.machines.push(...drafted.map((m) => ({ id: m.id, label: m.id, reach: m.reach, ollama: { port: m.port } })));
  });
  for (const m of drafted) await noteHostUse(deps, m.reach, { kind: "machine-added", machine: m.id });
  return { output: `${before}${drafted.map((m) => `added ${m.id}  ${reachText(m.reach)}  ollama port ${m.port}\n`).join("")}` };
}

function findMachine(registry: Registry, id: string | undefined): Machine {
  const machine = registry.machines.find((m) => m.id === id);
  if (!machine) throw new Error(`no machine "${id ?? ""}"; aya machines lists them`);
  return machine;
}

export async function handleMachinesRequest(request: MachinesRequest, deps: MachinesDeps, pane?: string, callerGone?: AbortSignal): Promise<MachinesAnswer> {
  const [sub, ...rest] = request.argv;
  const now = () => deps.now?.() ?? new Date();
  if (sub === undefined || sub === "--json") {
    if (rest.length) throw new Error(USAGE);
    const status = await machinesStatus(deps);
    return { output: sub === "--json" ? `${JSON.stringify(status, null, 2)}\n` : formatMachines(status.machines, now()) };
  }
  if (sub === "hosts") {
    if (rest[0] === "--json") return { output: `${JSON.stringify({ version: MACHINES_VERSION, hosts: await knownHosts(deps) }, null, 2)}\n` };
    if (rest.length) throw new Error(USAGE);
    return { output: formatHosts(await knownHosts(deps), now()) };
  }
  if (sub === "add") {
    if (rest.some((arg) => arg.startsWith("--"))) throw new Error(ADD_TAKES_A_SENTENCE);
    const registry = await loadRegistry(deps);
    const targets = (await knownHosts(deps, registry)).map((h) => h.target);
    const sentence = rest.join(" ").trim();
    if (!sentence) throw new Error(USAGE);
    const draft = draftFromSentence(sentence, targets, registry);
    const output = formatDraft(draft);
    if (draft.machines.length === 0) return { output };
    return addMachines(draft.machines, deps, pane, output, callerGone);
  }
  if (sub === "remove") {
    if (rest.length !== 1) throw new Error(USAGE);
    const asked = findMachine(await loadRegistry(deps), rest[0]);
    if (!deps.confirmRemove) throw new Error("removing a machine needs the user's yes in Aya, and Aya's dialog is not available here; nothing was removed");
    if (!(await deps.confirmRemove(asked.id, callerGone))) return { output: `Not removed: cancelled in Aya.\n` };
    if (callerGone?.aborted) throw new Error("the command stopped waiting for the user's answer; nothing was removed");
    const machine = await mutateRegistry(deps, (registry) => {
      const found = findMachine(registry, rest[0]);
      registry.machines = registry.machines.filter((m) => m !== found);
      return found;
    });
    await noteHostUse(deps, machine.reach, { kind: "machine-removed", machine: machine.id });
    return { output: `removed ${machine.id}\n` };
  }
  if (sub === "free") {
    if (rest.length !== 1) throw new Error(USAGE);
    return mutateRegistry(deps, (registry) => {
      const machine = findMachine(registry, rest[0]);
      const previous = machine.occupancy;
      delete machine.occupancy;
      return { output: previous ? `${machine.id} is free (was: ${previous.purpose}, by ${previous.by})\n` : `${machine.id} was not occupied\n` };
    });
  }
  if (sub === "occupy") {
    const purpose = rest.slice(1).join(" ").trim();
    if (!purpose) throw new Error(`say what it is for: aya machines occupy ${rest[0] ?? "<id>"} "<purpose>"`);
    if (purpose.length > PURPOSE_MAX_CHARS) throw new Error(`the purpose is ${purpose.length} characters, the most is ${PURPOSE_MAX_CHARS}`);
    return mutateRegistry(deps, (registry) => {
      const machine = findMachine(registry, rest[0]);
      const previous = machine.occupancy;
      machine.occupancy = { by: request.user || "unknown", ...(pane ? { pane } : {}), purpose, since: now().toISOString() };
      const was = previous ? ` (replaces: ${previous.purpose}, by ${previous.by})` : "";
      return { output: `${machine.id} occupied: ${purpose}${was}. Advisory only: nothing is blocked.\n` };
    });
  }
  throw new Error(USAGE);
}
