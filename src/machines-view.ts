// Text for the machines status bar item and Settings > Machines: the facts `aya machines` prints, so color is never the only signal.

import type { MachineClaim, MachineReach, MachineStatus, MachineView } from "./types";
import { gib, gibFromMiB } from "./units";

export const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export const reachText = (reach: MachineReach) => (reach === "local" ? "this machine" : `ssh ${reach.ssh}`);

/** A repair hint for known LAN transport failures, not a diagnosis of the user's system permission. */
export function needsLocalNetworkSettings(machine: MachineView, platform: string): boolean {
  if (platform !== "darwin" || !machine.api || machine.status.api?.up || !["API host unreachable", "API network access denied"].includes(machine.status.api?.error ?? "")) return false;
  let host: string;
  try { host = new URL(machine.api.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  if (host === "localhost" || host === "::1" || host.startsWith("127.")) return false;
  const ipv4 = host.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 169 && ipv4[1] === 254);
  }
  return /^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host) || host.endsWith(".local") || host.endsWith(".lan") || (!host.includes(".") && !host.includes(":"));
}

type HealthWord = "Ready" | "GPU error" | "API not answering" | "Ollama not answering" | "Ollama not running" | "Ollama not installed" | "Unreachable";

/** Each state says what is true and so what to do: a silent Ollama port is told apart by whether Ollama is installed
 *  and whether its process runs. API availability is independent of host/GPU telemetry. */
export function health(s: MachineStatus): { word: HealthWord; level: "ok" | "warn" | "down" } {
  if (s.api) return s.api.up ? { word: "Ready", level: "ok" } : { word: "API not answering", level: "warn" };
  if (!s.reachable) return { word: "Unreachable", level: "down" };
  if (!s.ollama.up) {
    if (s.ollama.installed === false) return { word: "Ollama not installed", level: "warn" };
    if (s.ollama.running === false) return { word: "Ollama not running", level: "warn" };
    return { word: "Ollama not answering", level: "warn" };
  }
  return s.gpuError ? { word: "GPU error", level: "warn" } : { word: "Ready", level: "ok" };
}

/** The primary availability state and its reason; a telemetry failure does not determine inference placement.
 *  ("Unreachable: Operation timed out", "GPU error: Driver/library version mismatch"). */
export function troubleText(s: MachineStatus): string {
  const word = health(s).word;
  if (s.api) return s.api.up ? "Ready" : (s.api.error ?? word);
  const why = !s.reachable ? s.error : s.ollama.up ? s.gpuError : null;
  const last = why?.split(": ").pop()?.trim();
  return last ? `${word}: ${last}` : word;
}

/** The least broken first: one that only needs a reboot or `ollama serve` before one that needs an install or the network. */
const HEALTH_ORDER: HealthWord[] = ["Ready", "GPU error", "API not answering", "Ollama not answering", "Ollama not running", "Ollama not installed", "Unreachable"];

/** Ready machines first, then those in trouble, the least broken first; the user's order within each. */
export function readyFirst<T extends { status: MachineStatus }>(views: T[]): T[] {
  return views
    .map((v, i) => ({ v, i, rank: HEALTH_ORDER.indexOf(health(v.status).word) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.v);
}

/** "Xeon E3-1245 V2" for "Intel(R) Xeon(R) CPU E3-1245 V2 @ 3.40GHz", "Ryzen 9 9950X3D" for "AMD Ryzen 9 9950X3D 16-Core
 *  Processor": the model, without marks, vendor, clock or core count. Apple's chips keep "Apple". */
export const shortCpuName = (name: string) =>
  name
    .replace(/\((?:R|TM)\)/gi, "")
    .replace(/\s*@.*$/, "")
    .replace(/\b\d+-Core Processor\b|\bProcessor\b|\bCPU\b/gi, "")
    .replace(/^(?:Intel|AMD)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim() || name;

/** "RTX 4090", or the CPU's model without an NVIDIA GPU: what tells a GPU box from a laptop. */
export function hardware(s: MachineStatus): string {
  if (s.gpus.length) return s.gpus.map((g) => g.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")).join(" + ");
  return s.cpuName ? shortCpuName(s.cpuName) : "";
}

const maxGpuUtil = (s: MachineStatus) => {
  const utils = s.gpus.map((g) => g.utilPct).filter((u): u is number => u !== null);
  return utils.length ? Math.max(...utils) : null;
};

/** How busy it is and how full its model memory is: GPU and VRAM with an NVIDIA GPU, else CPU load and RAM. */
export function loadText(s: MachineStatus): string {
  if (s.gpus.length) {
    const sum = (k: "memUsedMiB" | "memTotalMiB") => (s.gpus.some((g) => g[k] === null) ? null : s.gpus.reduce((a, g) => a + (g[k] ?? 0), 0));
    return `GPU ${maxGpuUtil(s) ?? "?"}% · VRAM ${gibFromMiB(sum("memUsedMiB"))}/${gibFromMiB(sum("memTotalMiB"))} GiB`;
  }
  // Load average over the core count, said in words: "CPU 18.5/10" read like an error.
  return `load ${s.load1 === null ? "?" : s.load1.toFixed(1)} on ${s.cpus ?? "?"} CPUs · RAM ${gib(s.memUsedBytes)}/${gib(s.memTotalBytes)} GiB`;
}

/** "until 16:28 (14 min)": whole minutes left, never rounded up. */
export function hotText(expiresAt: string | null, pinned: boolean, now: Date): string {
  if (pinned) return "pinned";
  if (!expiresAt) return "loaded";
  const min = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 60_000);
  return min < 0 ? "expired" : `until ${clock(expiresAt)} (${min} min)`;
}

/** One line per loaded model; "unavailable" when /api/ps gave no list, never "no model loaded". */
export function modelLines(s: MachineStatus, now: Date): string[] {
  if (s.api) return !s.api.up ? [] : s.api.models?.length ? s.api.models.map((id) => `${id} · served by API`) : ["No models served by API"];
  if (!s.reachable) return [];
  // Only a ready machine lists its models; one in trouble is a single line (troubleText).
  if (!s.ollama.up) return [];
  if (s.ollama.loaded === null) return [`Models unavailable (${s.ollama.modelsError ?? "?"})`];
  if (s.ollama.loaded.length === 0) return ["No model loaded"];
  return s.ollama.loaded.map((m) => [m.name, ...(m.vramBytes === null ? [] : [`${gib(m.vramBytes)} GiB (reported by Ollama)`]), hotText(m.expiresAt, m.pinned, now)].join(" · "));
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
