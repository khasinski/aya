// Text for Settings > Machines; the same facts `aya machines` prints, so color is never the only signal.

import type { HostEvent, HostOrigin, HostSource, KnownHost, MachineReach, MachineStatus, MachineView } from "./types";

const gib = (bytes: number | null) => (bytes === null ? "?" : (bytes / 2 ** 30).toFixed(1));
const gibFromMiB = (mib: number | null) => (mib === null ? "?" : (mib / 1024).toFixed(1));
export const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export const reachText = (reach: MachineReach) => (reach === "local" ? "this machine" : `ssh ${reach.ssh}`);

export function stateLine(reach: MachineReach, s: MachineStatus): string {
  return `${s.reachable ? "Connected" : "Unreachable"} · ${reachText(reach)} · checked ${clock(s.checkedAt)}`;
}

export function gpuText(s: MachineStatus): string {
  if (s.gpus.length === 0) return "none seen (nvidia-smi absent)";
  return s.gpus.map((g) => `${g.name} · ${g.utilPct ?? "?"}% · ${gibFromMiB(g.memUsedMiB)}/${gibFromMiB(g.memTotalMiB)} GB VRAM`).join("; ");
}

export const cpuText = (s: MachineStatus) => `load ${s.load1 === null ? "?" : s.load1.toFixed(1)} on ${s.cpus ?? "?"} cores`;
export const memoryText = (s: MachineStatus) => `${gib(s.memUsedBytes)}/${gib(s.memTotalBytes)} GB`;

export function ollamaText(s: MachineStatus, port: number): string {
  return s.ollama.up ? `Ollama ${s.ollama.version ?? "?"}` : `Ollama not answering on port ${port}`;
}

export function hotUntil(expiresAt: string | null, pinned: boolean, now: Date): string {
  if (pinned) return "pinned";
  if (!expiresAt) return "loaded";
  const at = new Date(expiresAt);
  const min = Math.round((at.getTime() - now.getTime()) / 60_000);
  return `hot until ${clock(expiresAt)} (${min >= 0 ? `${min} min` : "expired"})`;
}

/** One line per loaded model; "unavailable" when /api/ps gave no list, never "no model loaded". */
export function modelLines(s: MachineStatus, now: Date): string[] {
  if (!s.ollama.up) return [];
  if (s.ollama.loaded === null) return [`models unavailable (${s.ollama.modelsError ?? "?"})`];
  if (s.ollama.loaded.length === 0) return ["no model loaded"];
  return s.ollama.loaded.map((m) => `${m.name} · ${hotUntil(m.expiresAt, m.pinned, now)}`);
}

export function occupancyText(o: NonNullable<MachineView["occupancy"]>): string {
  return `In use: ${o.purpose} · ${o.by}${o.pane ? ` (pane ${o.pane})` : ""} · since ${clock(o.since)}`;
}

/** What a Check of a suggested host found, in one line. */
export function foundText(s: MachineStatus, port: number, now: Date): string {
  if (!s.reachable) return `Not reachable: ${s.error ?? "?"}`;
  const gpu = s.gpus.length ? `GPU ${s.gpus.map((g) => g.name).join(", ")}` : "no NVIDIA GPU";
  const models = modelLines(s, now);
  return ["Reachable", gpu, `memory ${memoryText(s)}`, ollamaText(s, port), ...models].join(" · ");
}

const SOURCE_TEXT: Record<HostSource, string> = { "ssh-config": "ssh config", "remote-project": "remote project", machine: "machine", saved: "used before" };

export function sourcesText(h: KnownHost, now = new Date()): string {
  const sources = h.sources
    // "used before" says nothing when another source already lists the host; its last use does.
    .filter((src) => src !== "saved" || h.sources.length === 1)
    .map((src) => (src === "remote-project" && h.projects?.length ? `remote project ${h.projects.join(", ")}` : SOURCE_TEXT[src]));
  if (h.saved?.lastUsedAt) sources.push(`last used ${whenText(h.saved.lastUsedAt, now)}`);
  return sources.join(" · ");
}

// The same wording as `aya machines hosts` (electron/machines.ts hostDetailLines).
const ORIGIN_TEXT: Record<HostOrigin, string> = { "open-project": "Open project", settings: "Settings > Machines", cli: "aya machines" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:50" today, "3 Oct 14:50" another day. */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? clock(iso) : `${at.getDate()} ${MONTHS[at.getMonth()]} ${clock(iso)}`;
}

/** "Used by: machine athena; project libeval; panes tester (tester in team qa), implementer". */
export function usageText(h: KnownHost): string {
  const used: string[] = [];
  if (h.machineId) used.push(`machine ${h.machineId}${h.occupancy ? ` (in use: ${h.occupancy.purpose}, by ${h.occupancy.by})` : ""}`);
  if (h.projects?.length) used.push(`project${h.projects.length > 1 ? "s" : ""} ${h.projects.join(", ")}`);
  if (h.panes?.length) {
    const panes = h.panes.map((p) => (p.role ? `${p.name} (${p.role} in team ${p.team})` : p.name));
    used.push(`pane${panes.length > 1 ? "s" : ""} ${panes.join(", ")}`);
  }
  return `Used by: ${used.length ? used.join("; ") : "nothing in Aya now"}`;
}

/** "Added 3 Oct 14:02 from Open project; last used 14:50 (remote project)", or why the host is not saved. */
export function savedText(h: KnownHost, now: Date): string {
  const s = h.saved;
  if (!s) return "Not saved: listed from its source until it is used";
  const last = s.lastUsedAt ? `; last used ${whenText(s.lastUsedAt, now)} (${s.lastUsedFor === "project" ? "remote project" : "Check"})` : "";
  return `Added ${whenText(s.addedAt, now)} from ${ORIGIN_TEXT[s.addedFrom]}${last}`;
}

export function lastCheckText(h: KnownHost, now: Date): string | null {
  const c = h.saved?.lastCheck;
  if (!c) return null;
  return `Last Check ${whenText(c.at, now)}: ${c.ok ? "reachable" : `not reachable, ${c.why ?? "?"}`}`;
}

export function historyText(e: HostEvent, now: Date): string {
  const from = e.from ? ` from ${ORIGIN_TEXT[e.from]}` : "";
  const what =
    e.event === "added"
      ? `added${e.machine ? ` as machine ${e.machine}` : ""}${from}`
      : e.event === "removed"
        ? `removed${e.machine ? ` machine ${e.machine}` : ""}${from}`
        : e.event === "connected"
          ? `connected${e.project ? ` (remote project ${e.project})` : " (Check)"}`
          : `Check failed: ${e.why ?? "?"}`;
  return `${whenText(e.at, now)} ${what}`;
}

/** Hosts in the order already shown, new ones after: a Check refreshes a row without moving it. */
export function keepOrder(shown: KnownHost[] | null, fresh: KnownHost[]): KnownHost[] {
  if (!shown) return fresh;
  const rank = new Map(shown.map((h, i) => [h.target.toLowerCase(), i]));
  const at = (h: KnownHost) => rank.get(h.target.toLowerCase()) ?? shown.length;
  return [...fresh].sort((a, b) => at(a) - at(b));
}

/** Known hosts not added as machines, plus this machine when it is not added. */
export function suggestions(hosts: KnownHost[], machines: MachineView[]): { target: string; label: string; sources: string; host?: KnownHost }[] {
  const added = new Set(machines.flatMap((m) => (m.reach === "local" ? [] : [m.reach.ssh.toLowerCase()])));
  const out: { target: string; label: string; sources: string; host?: KnownHost }[] = hosts
    .filter((h) => !h.machineId && !added.has(h.target.toLowerCase()))
    .map((h) => ({ target: h.target, label: h.target, sources: sourcesText(h), host: h }));
  if (!machines.some((m) => m.reach === "local")) out.push({ target: "local", label: "This machine", sources: "local" });
  return out;
}
