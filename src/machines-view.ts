// Text for the machines status bar item and Settings > Machines: the facts `aya machines` prints, so color is never the only signal.

import type { MachineClaim, MachineReach, MachineStatus, MachineView } from "./types";

const gib = (bytes: number | null) => (bytes === null ? "?" : (bytes / 2 ** 30).toFixed(1));
const gibFromMiB = (mib: number | null) => (mib === null ? "?" : (mib / 1024).toFixed(1));
export const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export const reachText = (reach: MachineReach) => (reach === "local" ? "this machine" : `ssh ${reach.ssh}`);

/** Ollama down is its own state: a connected host without Ollama cannot serve a model. */
export function health(s: MachineStatus): { word: "Ready" | "Ollama down" | "Unreachable"; level: "ok" | "warn" | "down" } {
  if (!s.reachable) return { word: "Unreachable", level: "down" };
  return s.ollama.up ? { word: "Ready", level: "ok" } : { word: "Ollama down", level: "warn" };
}

/** "RTX 4090", or the CPU's name without an NVIDIA GPU: what tells a GPU box from a laptop. */
export function hardware(s: MachineStatus): string {
  if (s.gpus.length) return s.gpus.map((g) => g.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")).join(" + ");
  return s.cpuName ?? "";
}

const maxGpuUtil = (s: MachineStatus) => {
  const utils = s.gpus.map((g) => g.utilPct).filter((u): u is number => u !== null);
  return utils.length ? Math.max(...utils) : null;
};

/** How busy it is and how full its model memory is: GPU and VRAM with an NVIDIA GPU, else CPU load and RAM. */
export function loadText(s: MachineStatus): string {
  if (s.gpus.length) {
    const sum = (k: "memUsedMiB" | "memTotalMiB") => (s.gpus.some((g) => g[k] === null) ? null : s.gpus.reduce((a, g) => a + (g[k] ?? 0), 0));
    return `GPU ${maxGpuUtil(s) ?? "?"}% · VRAM ${gibFromMiB(sum("memUsedMiB"))}/${gibFromMiB(sum("memTotalMiB"))} GB`;
  }
  return `CPU ${s.load1 === null ? "?" : s.load1.toFixed(1)}/${s.cpus ?? "?"} · RAM ${gib(s.memUsedBytes)}/${gib(s.memTotalBytes)} GB`;
}

/** "until 16:28 (14 min)": whole minutes left, never rounded up. */
export function hotText(expiresAt: string | null, pinned: boolean, now: Date): string {
  if (pinned) return "pinned";
  if (!expiresAt) return "loaded";
  const min = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 60_000);
  return min < 0 ? "expired" : `until ${clock(expiresAt)} (${min} min)`;
}

/** One line per loaded model; "unavailable" when /api/ps gave no list, never "no model loaded". */
export function modelLines(s: MachineStatus, port: number, now: Date): string[] {
  if (!s.reachable) return [];
  if (!s.ollama.up) return [`Ollama not answering on port ${port}`];
  if (s.ollama.loaded === null) return [`Models unavailable (${s.ollama.modelsError ?? "?"})`];
  if (s.ollama.loaded.length === 0) return ["No model loaded"];
  return s.ollama.loaded.map((m) => [m.name, ...(m.vramBytes === null ? [] : [`${gib(m.vramBytes)} GB`]), hotText(m.expiresAt, m.pinned, now)].join(" · "));
}

/** "run5 timed collection · justi (pane lead) · since 15:49", with its age once it is an hour old. */
export function claimText(c: MachineClaim, now: Date): string {
  const hours = Math.floor((now.getTime() - new Date(c.since).getTime()) / 3_600_000);
  return `${c.purpose} · ${c.by}${c.pane ? ` (pane ${c.pane})` : ""} · since ${clock(c.since)}${hours >= 1 ? ` (${hours} h ago)` : ""}`;
}

/** The status bar icon's accessible name and tooltip: every machine with its state in words. */
export function barLabel(views: MachineView[]): string {
  return `Machines: ${views.map((v) => `${v.id} ${health(v.status).word.toLowerCase()}${v.claim ? ", claimed" : ""}`).join("; ")}`;
}

/** The Settings answer to an add, as sentences: who was added and the CLI's notes, without its draft lines. */
export function addAnswerText(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const added = lines.flatMap((l) => /^added (\S+)/.exec(l)?.[1] ?? []);
  const notes = lines
    .filter((l) => l !== "Draft:" && !/^added /.test(l) && !/ ollama port \d+$/.test(l))
    .map((l) =>
      l
        .replace(/^(.+): already added$/, "$1 is already added.")
        .replace(/: no such Host in ~\/\.ssh\/config and no known host.*$/, ": no such host in ~/.ssh/config and no known host."),
    );
  const who = added.length > 1 ? `${added.slice(0, -1).join(", ")} and ${added[added.length - 1]}` : added[0];
  return [...(who ? [`Added ${who}.`] : []), ...notes].join(" ");
}

/** Sent on window when Settings adds or removes a machine, so the status bar reads the list again at once. */
export const MACHINES_CHANGED_EVENT = "aya:machines-changed";
