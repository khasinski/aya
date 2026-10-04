// Text for Settings > Machines; the same facts `aya machines` prints, so color is never the only signal.

import type { HostSource, KnownHost, MachineReach, MachineStatus, MachineView } from "./types";

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

const SOURCE_TEXT: Record<HostSource, string> = { "ssh-config": "ssh config", "remote-project": "remote project", machine: "machine" };

export function sourcesText(h: KnownHost): string {
  return h.sources
    .map((src) => (src === "remote-project" && h.projects?.length ? `remote project ${h.projects.join(", ")}` : SOURCE_TEXT[src]))
    .join(" · ");
}

/** Known hosts not added as machines, plus this machine when it is not added. */
export function suggestions(hosts: KnownHost[], machines: MachineView[]): { target: string; label: string; sources: string }[] {
  const added = new Set(machines.flatMap((m) => (m.reach === "local" ? [] : [m.reach.ssh.toLowerCase()])));
  const out = hosts.filter((h) => !h.machineId && !added.has(h.target.toLowerCase())).map((h) => ({ target: h.target, label: h.target, sources: sourcesText(h) }));
  if (!machines.some((m) => m.reach === "local")) out.push({ target: "local", label: "This machine", sources: "local" });
  return out;
}
