// `aya machines`: the registry, the one-sentence add, claims and the status text (docs/machines.md).
// Read-only towards every machine: nothing here loads, unloads or calls a model.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { oneAtATime } from "./keyed-queue";
import { probeMachine, type MachineStatus, type Reach } from "./machines-probe";
import { isSshTarget } from "./ssh";
import { sshHostAliases } from "./ssh-hosts";
import { singleFlight } from "./single-flight";
import { gib, gibFromMiB } from "./units";
import { normalizeApiUrl, probeApi, type ApiBackend } from "./machines-api";
import { MACHINES_AUTH_FILE, machineToken, savedTokenPreview, saveMachineToken, validateMachineToken } from "./machines-auth";
import { discoverApiEndpoints, type ApiDiscovery } from "./machines-discovery";
import { hostTelemetryUnavailableText } from "../shared/machines-status-text.cjs";

export const MACHINES_FILE_NAME = "machines.json";
export const MACHINES_VERSION = 1;
export const DEFAULT_OLLAMA_PORT = 11434;
export const STATUS_CACHE_MS = 3_000;
const MACHINES_FILE_MODE = 0o600;
const ID_PATTERN = /^[a-z0-9-]+$/;
const PURPOSE_MAX_CHARS = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const LOCAL_WORDS = new Set(["local"]);
const LOCAL_PHRASES = [/\bthis machine\b/i];
const LOCAL_PHRASE_WORD = "this-machine";
/** Words that start a clause like a host name would ("it is ..."), never a host. */
const NOT_HOSTS = new Set(["it", "this", "that", "there", "which", "ollama", "ssh", "and", "also", "my", "the"]);
/** Words people use for a machine that say nothing about how to reach it: asked, never taken as local. */
const AMBIGUOUS_WORDS = new Set(["laptop", "notebook", "mac", "macbook", "imac", "desktop", "workstation", "pc", "computer"]);

/** Who said they use a machine and for what; advisory, nothing is blocked. */
export interface Claim {
  by: string;
  pane?: string;
  purpose: string;
  since: string;
}

export interface Machine {
  id: string;
  reach: Reach;
  ollama: { port: number };
  api?: ApiBackend;
  claim?: Claim;
}

/** Local desktop settings metadata, never registry/status/CLI or windowless Web responses. */
export interface MachineSetup extends Machine {
  api?: ApiBackend & { savedTokenPreview?: string };
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
  /** Remote projects, whose ssh targets are known hosts too. */
  listRemoteProjects?: () => Promise<{ name: string; sshTarget: string }[]>;
  probe?: typeof probeMachine;
  now?: () => Date;
  /** Aya's own Add / Cancel dialog with the probe results; without it nothing can be added. It closes on `signal`. */
  confirmAdd?: (ask: AddAsk, signal?: AbortSignal) => Promise<boolean>;
  confirmRemove?: (id: string, signal?: AbortSignal) => Promise<boolean>;
  /** Aya's own Change / Cancel dialog before a backend or its token changes; Settings passes its own click. */
  confirmConfigure?: (ask: ConfigureAsk, signal?: AbortSignal) => Promise<boolean>;
}

/** What `aya machines configure` would change, shown to the user before anything is saved. */
export interface ConfigureAsk {
  id: string;
  backend: "ollama" | "openai-compatible";
  /** The normalized API URL, or the Ollama port. */
  target: string;
  /** What happens to the machine's saved API token. */
  token: "stored" | "kept" | "removed" | "none";
  /** The pane whose agent asked, when one did. */
  pane?: string;
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
    const reach = machine.reach as { ssh?: unknown } | string | undefined;
    const reachOk = reach === "local" || (typeof reach === "object" && reach !== null && typeof reach.ssh === "string" && isSshTarget(reach.ssh));
    if (!reachOk) return `${at}: reach must be "local" or {"ssh": "<alias or user@host>"}`;
    const port = (machine.ollama as { port?: unknown } | undefined)?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return `${at}: ollama.port is not a port number`;
    if (machine.api !== undefined) {
      const api = machine.api as { baseUrl?: unknown } | null;
      if (!api || typeof api.baseUrl !== "string") return `${at}: API needs a base URL`;
      try { normalizeApiUrl(api.baseUrl); } catch { return `${at}: invalid API base URL`; }
    }
    const c = machine.claim as Record<string, unknown> | undefined;
    const claimOk =
      c === undefined ||
      (typeof c === "object" && c !== null && typeof c.by === "string" && c.by !== "" && typeof c.purpose === "string" && c.purpose !== "" &&
        typeof c.since === "string" && !Number.isNaN(Date.parse(c.since)) && (c.pane === undefined || typeof c.pane === "string") &&
        ![c.by, c.purpose, c.pane].some((t) => typeof t === "string" && CONTROL_CHARS.test(t)));
    if (!claimOk) {
      return `${at}: claim needs by, purpose and since (a date), and pane if any, all plain text`;
    }
  }
  return null;
}

export async function loadRegistry(deps: MachinesDeps): Promise<Registry> {
  const file = registryFile(deps);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: MACHINES_VERSION, machines: [] };
    throw err;
  }
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
  // Pick public fields rather than spreading disk objects into setup/status. Credentials never belong here.
  return { version: MACHINES_VERSION, machines: (parsed as Registry).machines.map((m) => ({
    id: m.id, reach: m.reach === "local" ? "local" : { ssh: m.reach.ssh }, ollama: { port: m.ollama.port },
    ...(m.api ? { api: { baseUrl: normalizeApiUrl(m.api.baseUrl) } } : {}),
    ...(m.claim ? { claim: { by: m.claim.by, purpose: m.claim.purpose, since: m.claim.since, ...(m.claim.pane ? { pane: m.claim.pane } : {}) } } : {}),
  })) };
}

export async function machinesSetup(deps: MachinesDeps): Promise<{ machines: Machine[]; hosts: KnownHost[] }> {
  const registry = await loadRegistry(deps);
  const machines = await Promise.all(registry.machines.map(async (m) => m.api ? {
    ...m, api: { baseUrl: m.api.baseUrl, tokenConfigured: !!(await machineToken(deps.ayaHome, m.id, m.api.baseUrl)) },
  } : m));
  return { machines, hosts: await knownHosts(deps, registry) };
}

export async function machinesUiSetup(deps: MachinesDeps): Promise<{ machines: MachineSetup[]; hosts: KnownHost[] }> {
  const registry = await loadRegistry(deps);
  const machines = await Promise.all(registry.machines.map(async (m): Promise<MachineSetup> => {
    if (!m.api) return m;
    const token = await machineToken(deps.ayaHome, m.id, m.api.baseUrl);
    return { ...m, api: { baseUrl: m.api.baseUrl, tokenConfigured: !!token, ...(token ? { savedTokenPreview: savedTokenPreview(token) } : {}) } };
  }));
  return { machines, hosts: await knownHosts(deps, registry) };
}

const discoveries = new Map<string, Promise<ApiDiscovery>>();
/** Only a saved machine's reach can be scanned; callers cannot supply arbitrary hosts/ports or credentials. */
export async function machinesDiscover(id: string, deps: MachinesDeps): Promise<ApiDiscovery> {
  if (!ID_PATTERN.test(id)) return { candidates: [], error: "Select an added machine first." };
  try {
    const machine = (await loadRegistry(deps)).machines.find((m) => m.id === id);
    if (!machine) return { candidates: [], error: "This machine is no longer configured." };
    const key = JSON.stringify([deps.ayaHome, machine.id, machine.reach]);
    const pending = discoveries.get(key);
    if (pending) return pending;
    const request = discoverApiEndpoints(machine.reach).finally(() => discoveries.delete(key));
    discoveries.set(key, request);
    return request;
  } catch { return { candidates: [], error: "Could not read the selected machine." }; }
}

const registryQueue = oneAtATime();

/** One registry change at a time (only Aya's main process writes it): read, change, check, write atomically.
 *  `afterSave` runs in the same turn once machines.json is written: a second file that must stay as it was when that write fails. */
export function mutateRegistry<T>(deps: MachinesDeps, change: (registry: Registry) => T | Promise<T>, afterSave?: () => Promise<void>): Promise<T> {
  const file = registryFile(deps);
  return registryQueue(file, async () => {
    const registry = await loadRegistry(deps);
    const result = await change(registry);
    const problem = registryProblem(registry);
    if (problem) throw new Error(`${problem}; nothing was saved`);
    await writeFileAtomic(file, `${JSON.stringify(registry, null, 2)}\n`, MACHINES_FILE_MODE);
    await afterSave?.();
    return result;
  });
}

// ---- known hosts ----

export interface KnownHost {
  target: string;
  sources: ("ssh config" | "remote project")[];
  /** The added machine reached at this target. */
  machine?: string;
}

/** ~/.ssh/config aliases and remote project targets, merged case-insensitively as ssh matches Host names. */
export async function knownHosts(deps: MachinesDeps, registry?: Registry): Promise<KnownHost[]> {
  const [aliases, projects, reg] = await Promise.all([
    sshHostAliases(deps.userHome),
    deps.listRemoteProjects?.().catch(() => []) ?? Promise.resolve([]),
    registry ? Promise.resolve(registry) : loadRegistry(deps),
  ]);
  const hosts = new Map<string, KnownHost>();
  const add = (target: string, source: KnownHost["sources"][number]) => {
    const t = target.trim();
    if (!isSshTarget(t)) return;
    const host = hosts.get(sshKey(t)) ?? { target: t, sources: [] };
    if (!host.sources.includes(source)) host.sources.push(source);
    hosts.set(sshKey(t), host);
  };
  for (const alias of aliases) add(alias, "ssh config");
  for (const p of projects) add(p.sshTarget, "remote project");
  for (const m of reg.machines) {
    const host = m.reach === "local" ? undefined : hosts.get(sshKey(m.reach.ssh));
    if (host && !host.machine) host.machine = m.id;
  }
  return [...hosts.values()];
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
/** ssh lowercases the host it is given, but a user name keeps its case: Alice@box and alice@box can be two accounts. */
const sshKey = (target: string) => {
  const at = target.lastIndexOf("@");
  return at < 0 ? target.toLowerCase() : `${target.slice(0, at)}@${target.slice(at + 1).toLowerCase()}`;
};
const sameReach = (a: Reach, b: Reach) => (a === "local" ? b === "local" : b !== "local" && sshKey(a.ssh) === sshKey(b.ssh));

/** Deterministic: known hosts (aliases, user@host), `local` / "this machine", `port N` after a machine; nothing else is guessed. */
export function draftFromSentence(sentence: string, aliases: string[], registry: Registry): SentenceDraft {
  const draft: SentenceDraft = { machines: [], unclear: [], unknown: [], alreadyAdded: [] };
  const byKey = new Map(aliases.map((a) => [sshKey(a), a]));
  // Aliases like a.b and a_b read as one id; the later one takes the next free number.
  const freeId = (base: string) => {
    const taken = (id: string) => registry.machines.some((m) => m.id === id) || draft.machines.some((m) => m.id === id);
    let id = base;
    for (let n = 2; taken(id); n++) id = `${base}-${n}`;
    return id;
  };
  // `port N` belongs to the machine named right before it, and to nothing when that one was already added.
  let named: DraftMachine | null = null;
  const add = (reach: Reach, word: string) => {
    named = null;
    if (registry.machines.some((m) => sameReach(m.reach, reach))) {
      if (!draft.alreadyAdded.includes(word)) draft.alreadyAdded.push(word);
      return;
    }
    named = draft.machines.find((m) => sameReach(m.reach, reach)) ?? null;
    if (named) return;
    named = { id: freeId(reach === "local" ? "local" : idFor(reach.ssh)), reach, port: DEFAULT_OLLAMA_PORT };
    draft.machines.push(named);
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
      if (named && port >= 1 && port <= 65535) named.port = port;
      return;
    }
    // "this machine" always means this machine; a `Host local` alias does win over the bare word local.
    if (lower === LOCAL_PHRASE_WORD) return add("local", "this machine");
    const known = byKey.get(sshKey(word));
    if (known) return add({ ssh: known }, word);
    // user@host names its own user and host, so it needs no Host block, as for a remote project.
    if (word.includes("@") && isSshTarget(word)) return add({ ssh: word }, word);
    if (LOCAL_WORDS.has(lower)) return add("local", word);
    // A machine that is asked about or unknown ends the one before it: its `port N` must not land there.
    if (AMBIGUOUS_WORDS.has(lower)) {
      named = null;
      if (!draft.unclear.includes(word)) draft.unclear.push(word);
      return;
    }
    const usedAsHost = next === "is" ? i === 0 || /^(and|also|then)$/.test(prev ?? "") : prev === "ssh" || prev === "host";
    if (usedAsHost && !NOT_HOSTS.has(lower) && /^[A-Za-z][A-Za-z0-9._-]*$/.test(word)) {
      named = null;
      if (!draft.unknown.includes(word)) draft.unknown.push(word);
    }
  });
  return draft;
}

// ---- status ----

export interface MachineView extends Machine {
  status: MachineStatus;
}

const statusCache = new Map<string, { at: number; status: MachineStatus }>();
const inFlight = new Map<string, () => Promise<MachineStatus>>();
let statusGeneration = 0;

/** One probe per machine in flight, shared by every caller, and reused for STATUS_CACHE_MS. */
export function machineStatus(machine: Machine, deps: MachinesDeps): Promise<MachineStatus> {
  const key = JSON.stringify([deps.ayaHome, machine.id, machine.reach, machine.ollama.port, machine.api?.baseUrl]);
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return Promise.resolve(cached.status);
  let run = inFlight.get(key);
  if (!run) {
    const generation = statusGeneration;
    run = singleFlight(async () => {
      const hardware = (deps.probe ?? probeMachine)(machine.reach, machine.ollama.port, { now: deps.now, ...(machine.api ? { hardwareOnly: true } : {}) });
      const api = machine.api ? (async () => {
        try { return await probeApi(machine.api!.baseUrl, await machineToken(deps.ayaHome, machine.id, machine.api!.baseUrl)); }
        catch { return { up: false, models: null, error: "API credentials unavailable" }; }
      })() : null;
      const [status, apiStatus] = await Promise.all([hardware, api]);
      if (apiStatus) status.api = apiStatus;
      if (generation === statusGeneration) statusCache.set(key, { at: Date.now(), status });
      return status;
    });
    inFlight.set(key, run);
  }
  return run();
}

/** Test-only: forget cached probes. */
export function clearMachineStatusCache(): void {
  statusGeneration += 1;
  statusCache.clear();
  inFlight.clear();
}

export async function machinesStatus(deps: MachinesDeps): Promise<{ version: number; machines: MachineView[] }> {
  const registry = await loadRegistry(deps);
  const machines = await Promise.all(registry.machines.map(async (m) => ({ ...m, status: await machineStatus(m, deps) })));
  return { version: MACHINES_VERSION, machines };
}

// ---- text ----

// GiB for memory and GPU alike (units.ts), so a 24564 MiB card and 32 GiB of RAM read on one scale.
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 8);
const hhmm = (iso: string) => clock(iso).slice(0, 5);
const reachText = (reach: Reach) => (reach === "local" ? "local" : `ssh:${reach.ssh}`);
const claimWho = (c: Claim) => (c.pane ? `${c.by} (pane "${c.pane}")` : c.by);
/** "RTX 4090" for "NVIDIA GeForce RTX 4090": what tells one box from another. */
const shortGpuName = (name: string) => name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "");

function hotUntil(expiresAt: string | null, pinned: boolean, now: Date): string {
  if (pinned) return "pinned";
  if (!expiresAt) return "loaded";
  const min = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 60_000);
  return `hot until ${hhmm(expiresAt)} (${min >= 0 ? `${min} min` : "expired"})`;
}

/** The machine line: GPU name and use first (the incidents were a slower box and a shared GPU), then CPU and memory. */
function machineLine(s: MachineStatus): string {
  const gpus = s.gpus.map((g) => `${shortGpuName(g.name)} GPU ${g.utilPct ?? "?"}% VRAM ${gibFromMiB(g.memUsedMiB)}/${gibFromMiB(g.memTotalMiB)} GiB`);
  const cpu = `${s.gpus.length ? "" : `${s.cpuName ?? "no NVIDIA GPU"}  `}CPU ${s.load1 === null ? "?" : s.load1.toFixed(1)}/${s.cpus ?? "?"}`;
  return [...gpus, cpu, `RAM ${gib(s.memUsedBytes)}/${gib(s.memTotalBytes)} GiB`].join("  ");
}

function modelLines(s: MachineStatus, port: number, now: Date): string[] {
  if (s.api) return [
    s.api.up ? "API available (OpenAI-compatible)" : (s.api.error ?? "API not answering"),
    ...(s.api.up ? (s.api.models?.length ? s.api.models.map((id) => `  ${id} (served by API)`) : ["  No models served by API"]) : []),
  ];
  if (!s.ollama.up) {
    if (s.ollama.installed === false) return ["ollama not installed"];
    if (s.ollama.running === false) return [`ollama not running (nothing on port ${port})`];
    return [`ollama not answering on port ${port}`];
  }
  const version = `ollama ${s.ollama.version ?? "?"}`;
  if (s.ollama.loaded === null) return [`${version}, models unavailable (${s.ollama.modelsError})`];
  if (s.ollama.loaded.length === 0) return [`${version}, no model loaded`];
  return [
    version,
    ...s.ollama.loaded.map((m) => `  ${m.name}${m.vramBytes === null ? "" : ` ${gib(m.vramBytes)} GiB (reported by Ollama)`} ${hotUntil(m.expiresAt, m.pinned, now)}`),
  ];
}

export function formatMachines(views: MachineView[], now = new Date()): string {
  if (views.length === 0) return 'no machines yet; add one in Settings > Machines or with aya machines add "<sentence>"\n';
  const idWidth = Math.max(...views.map((v) => v.id.length));
  const pad = " ".repeat(idWidth + 2);
  const lines: string[] = [];
  for (const v of views) {
    const s = v.status;
    const head = `${v.id.padEnd(idWidth)}  `;
    if (!s.reachable) {
      lines.push(s.api?.up
        ? `${head}${hostTelemetryUnavailableText(s.error, v.reach === "local" ? null : v.reach.ssh)}`
        : `${head}unreachable  ${reachText(v.reach)}  ${s.error}`);
      if (s.api) lines.push(...modelLines(s, v.ollama.port, now).map((l) => pad + l));
    } else {
      lines.push(`${head}${machineLine(s)}  ${reachText(v.reach)}`);
      if (s.gpuError) lines.push(`${pad}GPU telemetry unavailable: nvidia-smi failed: ${s.gpuError}`);
      lines.push(...modelLines(s, v.ollama.port, now).map((l) => pad + l));
    }
    lines.push(pad + (v.claim ? `claimed by ${claimWho(v.claim)} since ${hhmm(v.claim.since)}: ${v.claim.purpose}` : "not claimed"));
  }
  const oldest = views.map((v) => v.status.checkedAt).sort()[0];
  lines.push(`checked ${clock(oldest)}`);
  return `${lines.join("\n")}\n`;
}

function formatHosts(hosts: KnownHost[]): string {
  if (hosts.length === 0) return "no known ssh hosts: no Host aliases in ~/.ssh/config and no remote projects\n";
  const width = Math.max(...hosts.map((h) => h.target.length));
  return hosts.map((h) => `${h.target.padEnd(width)}  ${h.sources.join(", ")}${h.machine ? `  (added as ${h.machine})` : ""}\n`).join("");
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
  /** Private input from stdin or a password field, never argv or output. */
  token?: string;
}

export interface MachinesAnswer {
  output: string;
}

const USAGE =
  'usage: aya machines [--json] | hosts [--json] | add "<sentence>" | remove <id> | configure <id> ollama [port] | configure <id> openai-compatible <url> [--token-stdin | --clear-token] | claim <id> "<purpose>" [--replace] | release <id>';

const ADD_TAKES_A_SENTENCE = 'aya machines add takes one sentence, not options: for example aya machines add "athena", or "this machine, port 11435"; nothing was added';

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
    // The write may wait behind another change; a caller that left meanwhile gets nothing saved.
    if (callerGone?.aborted) throw gone;
    for (const m of drafted) {
      if (registry.machines.some((x) => x.id === m.id || sameReach(x.reach, m.reach))) throw new Error(`${m.id} was already added meanwhile; nothing was saved`);
    }
    registry.machines.push(...drafted.map((m) => ({ id: m.id, reach: m.reach, ollama: { port: m.port } })));
  });
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
  if (request.token !== undefined && sub !== "configure") throw new Error("API token input is only accepted by configure");
  if (sub === undefined || sub === "--json") {
    if (rest.length) throw new Error(USAGE);
    const status = await machinesStatus(deps);
    return { output: sub === "--json" ? `${JSON.stringify(status, null, 2)}\n` : formatMachines(status.machines, now()) };
  }
  if (sub === "hosts") {
    if (rest.length > 1 || (rest[0] !== undefined && rest[0] !== "--json")) throw new Error(USAGE);
    const hosts = await knownHosts(deps);
    return { output: rest[0] ? `${JSON.stringify({ version: MACHINES_VERSION, hosts }, null, 2)}\n` : formatHosts(hosts) };
  }
  if (sub === "add") {
    if (rest.some((arg) => arg.startsWith("--"))) throw new Error(ADD_TAKES_A_SENTENCE);
    const sentence = rest.join(" ").trim();
    if (!sentence) throw new Error(USAGE);
    const registry = await loadRegistry(deps);
    const targets = (await knownHosts(deps, registry)).map((h) => h.target);
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
    let hadApi = false;
    await mutateRegistry(deps, async (registry) => {
      const found = findMachine(registry, rest[0]);
      if (!sameReach(found.reach, asked.reach)) throw new Error(`${asked.id} changed while Aya asked; nothing was removed`);
      // Read first, so an unreadable credentials file stops the removal before machines.json changes.
      if (found.api) await machineToken(deps.ayaHome, found.id, found.api.baseUrl);
      hadApi = !!found.api;
      registry.machines = registry.machines.filter((m) => m !== found);
    }, async () => {
      // The token goes only once the machine is gone: a failed registry write keeps both.
      if (!hadApi) return;
      try { await saveMachineToken(deps.ayaHome, asked.id, null); }
      catch { throw new Error(`removed ${asked.id}, but its saved API token could not be deleted from ${MACHINES_AUTH_FILE}`); }
    });
    return { output: `removed ${asked.id}\n` };
  }
  if (sub === "configure") {
    const [id, backend, value, flag] = rest;
    const api = backend === "openai-compatible";
    if ((api && (!value || rest.length > 4 || (flag !== undefined && !["--token-stdin", "--clear-token"].includes(flag)))) ||
        (!api && (backend !== "ollama" || rest.length > 3)) ||
        (flag === "--token-stdin" && request.token === undefined) ||
        (request.token !== undefined && (!api || flag !== "--token-stdin"))) throw new Error(USAGE);
    if (request.token !== undefined) validateMachineToken(request.token);
    const baseUrl = api ? normalizeApiUrl(value) : null;
    const port = api ? DEFAULT_OLLAMA_PORT : value === undefined ? DEFAULT_OLLAMA_PORT : Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ollama port must be 1..65535");
    const clear = flag === "--clear-token";
    const asked = findMachine(await loadRegistry(deps), id);
    // What happens to the token saved for the machine's current URL. Reading it also stops an unreadable credentials
    // file here, before the user is asked or machines.json changes.
    const tokenFate = async (machine: Machine): Promise<ConfigureAsk["token"]> => {
      if (!api && !machine.api) return "none";
      const saved = await machineToken(deps.ayaHome, machine.id, machine.api?.baseUrl ?? "");
      if (request.token !== undefined) return "stored";
      if (!saved) return "none";
      return !clear && machine.api?.baseUrl === baseUrl ? "kept" : "removed";
    };
    const token = await tokenFate(asked);
    if (!deps.confirmConfigure) throw new Error("configuring a machine needs the user's yes in Aya, and Aya's dialog is not available here; nothing was changed");
    const ask: ConfigureAsk = { id: asked.id, backend: api ? "openai-compatible" : "ollama", target: baseUrl ?? String(port), token, ...(pane ? { pane } : {}) };
    if (!(await deps.confirmConfigure(ask, callerGone))) return { output: `Not configured: cancelled in Aya.\n` };
    if (callerGone?.aborted) throw new Error("the command stopped waiting for the user's answer; nothing was changed");
    const label = api ? "OpenAI-compatible API" : `Ollama port ${port}`;
    await mutateRegistry(deps, async (registry) => {
      const machine = findMachine(registry, id);
      // Token writes happen only in this queue, so what the user was told about the token still holds after this check.
      if (!sameReach(machine.reach, asked.reach) || machine.api?.baseUrl !== asked.api?.baseUrl || machine.ollama.port !== asked.ollama.port || (await tokenFate(machine)) !== token) {
        throw new Error(`${asked.id} changed while Aya asked; nothing was changed`);
      }
      if (baseUrl) machine.api = { baseUrl };
      else { delete machine.api; machine.ollama = { port }; }
    }, async () => {
      // Credentials change only once machines.json is saved, so a failed registry write never costs the saved token.
      if (!api && !asked.api) return;
      // Without a new token, only the current URL's token is kept: one left for another URL (a failed earlier write) goes.
      const keepNone = clear || (request.token === undefined && asked.api?.baseUrl !== baseUrl);
      try { await saveMachineToken(deps.ayaHome, asked.id, baseUrl, request.token, keepNone); }
      catch { throw new Error(`${asked.id} now uses ${label}, but its API token could not be updated; configure it again`); }
    }).finally(clearMachineStatusCache);
    return { output: `${asked.id} configured: ${label}\n` };
  }
  if (sub === "release") {
    if (rest.length !== 1) throw new Error(USAGE);
    return mutateRegistry(deps, (registry) => {
      const machine = findMachine(registry, rest[0]);
      const previous = machine.claim;
      delete machine.claim;
      return { output: previous ? `${machine.id} released (was: ${previous.purpose}, by ${claimWho(previous)})\n` : `${machine.id} was not claimed\n` };
    });
  }
  if (sub === "claim") {
    const replace = rest.includes("--replace");
    const [id, ...words] = rest.filter((a) => a !== "--replace");
    const purpose = words.join(" ").trim();
    if (!purpose) throw new Error(`say what it is for: aya machines claim ${id ?? "<id>"} "<purpose>"`);
    if (CONTROL_CHARS.test(purpose)) throw new Error("the purpose must be one line of plain text");
    if (purpose.length > PURPOSE_MAX_CHARS) throw new Error(`the purpose is ${purpose.length} characters, the most is ${PURPOSE_MAX_CHARS}`);
    const by = request.user || "unknown";
    return mutateRegistry(deps, (registry) => {
      const machine = findMachine(registry, id);
      const held = machine.claim;
      const own = held && held.by === by && held.pane === pane;
      if (held && !own && !replace) {
        throw new Error(
          `${machine.id} is claimed by ${claimWho(held)} since ${hhmm(held.since)}: ${held.purpose}. Not changed; ask the user, or add --replace to take it over.`,
        );
      }
      machine.claim = { by, ...(pane ? { pane } : {}), purpose, since: now().toISOString() };
      const took = held && !own ? ` (took it over from ${claimWho(held)}: ${held.purpose})` : "";
      return { output: `${machine.id} claimed: ${purpose}${took}. Advisory: nothing is blocked.\n` };
    });
  }
  throw new Error(USAGE);
}
