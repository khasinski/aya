// Read-only probes of a machine for `aya machines` (docs/machines.md).

import { lastStderrLine, requireSshTarget, runProcess, runSsh, sshFailure } from "./ssh";

export const PROBE_DEADLINE_MS = 10_000;
const MAX_PROBE_OUTPUT_BYTES = 1_000_000;
// Ollama's keep_alive -1 shows an expiry this far out; anything later reads as pinned.
const PINNED_AFTER_YEAR = 2100;

export interface GpuLoad {
  name: string;
  utilPct: number | null;
  memUsedMiB: number | null;
  memTotalMiB: number | null;
}

export interface LoadedModel {
  name: string;
  vramBytes: number | null;
  expiresAt: string | null;
  pinned: boolean;
}

export interface OllamaState {
  up: boolean;
  version: string | null;
  loaded: LoadedModel[] | null;
  modelsError: string | null;
}

export interface MachineStatus {
  reachable: boolean;
  checkedAt: string;
  error: string | null;
  /** The CPU's name ("Apple M2 Max", "AMD Ryzen 9 7950X"), what tells a laptop from a GPU box without NVIDIA. */
  cpuName: string | null;
  cpus: number | null;
  load1: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  gpus: GpuLoad[];
  ollama: OllamaState;
}

export type Reach = "local" | { ssh: string };

/** -q first, so the host's ~/.curlrc (a body, a method, a proxy) is never read; no proxy; GET only, no body. */
const CURL_GET = "curl -q -s --noproxy '*' -X GET --max-time 3";

/** The probe script, for macOS and Linux alike; sections are marked so a missing tool leaves an empty section, not a parse error. */
export function probeScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad Ollama port ${port}`);
  const url = `http://127.0.0.1:${port}`;
  return [
    "echo @@cpuname; sysctl -n machdep.cpu.brand_string 2>/dev/null || sed -n 's/^model name[[:space:]]*: //p' /proc/cpuinfo 2>/dev/null | head -n 1",
    "echo @@nproc; nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null",
    "echo @@loadavg; cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null",
    "echo @@meminfo; cat /proc/meminfo 2>/dev/null",
    "echo @@vmstat; [ -r /proc/meminfo ] || vm_stat 2>/dev/null",
    "echo @@memsize; [ -r /proc/meminfo ] || sysctl -n hw.memsize 2>/dev/null",
    "echo @@gpu; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null",
    `echo @@version; ${CURL_GET} ${url}/api/version 2>/dev/null; echo`,
    `echo @@ps; ${CURL_GET} ${url}/api/ps 2>/dev/null; echo`,
    "echo @@end",
    "",
  ].join("\n");
}

export function splitSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  for (const line of output.split("\n")) {
    const marker = /^@@([a-z]+)\s*$/.exec(line);
    if (marker) {
      if (current) sections.set(current, lines.join("\n").trim());
      current = marker[1];
      lines = [];
    } else if (current) {
      lines.push(line);
    }
  }
  if (current) sections.set(current, lines.join("\n").trim());
  return sections;
}

const num = (text: string | undefined): number | null => {
  if (text === undefined) return null;
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? value : null;
};

export function parseLoad1(text: string): number | null {
  // /proc/loadavg "3.20 2.10 ..." or sysctl vm.loadavg "{ 3.20 2.10 1.90 }"
  const first = text.replace(/[{}]/g, " ").trim().split(/\s+/)[0];
  return num(first);
}

export function parseMeminfo(text: string): { used: number; total: number } | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable") ?? kb("MemFree");
  return total !== null && available !== null ? { used: total - available, total } : null;
}

/** Used = active + wired + compressed pages, what macOS calls memory used. */
export function parseVmStat(text: string, totalBytes: number | null): { used: number; total: number } | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!pageSize) return null;
  const pages = (label: string) => Number(new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
  return totalBytes ? { used, total: totalBytes } : null;
}

export function parseNvidiaSmi(text: string): GpuLoad[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, util, used, total] = line.split(",").map((part) => part.trim());
      return { name, utilPct: num(util), memUsedMiB: num(used), memTotalMiB: num(total) };
    })
    .filter((gpu) => gpu.name && !/^(NVIDIA-SMI has failed|No devices)/i.test(gpu.name));
}

function parseJson(text: string | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `loaded` null with `modelsError` when /api/ps gave no model list: unknown, never shown as "no model loaded". */
export function parseOllama(versionText: string | undefined, psText: string | undefined): OllamaState {
  const version = parseJson(versionText) as { version?: unknown } | null;
  const ps = parseJson(psText) as { models?: unknown } | null;
  // An entry that is not an object is skipped: one odd answer never takes down the status of every machine.
  const models = Array.isArray(ps?.models)
    ? (ps.models as unknown[]).filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && !Array.isArray(m))
    : null;
  const up = typeof version?.version === "string" || models !== null;
  return {
    up,
    version: typeof version?.version === "string" ? version.version : null,
    loaded:
      models?.map((m) => {
        const expiresAt = typeof m.expires_at === "string" ? m.expires_at : null;
        const year = expiresAt ? new Date(expiresAt).getUTCFullYear() : NaN;
        return {
          name: String(m.name ?? m.model ?? "?"),
          vramBytes: typeof m.size_vram === "number" ? m.size_vram : null,
          expiresAt,
          pinned: year > PINNED_AFTER_YEAR,
        };
      }) ?? null,
    modelsError: models !== null ? null : psText ? "unexpected answer from /api/ps" : "no answer from /api/ps",
  };
}

const emptyStatus = (checkedAt: string, error: string | null): MachineStatus => ({
  reachable: error === null,
  checkedAt,
  error,
  cpuName: null,
  cpus: null,
  load1: null,
  memUsedBytes: null,
  memTotalBytes: null,
  gpus: [],
  ollama: { up: false, version: null, loaded: null, modelsError: "not probed" },
});

/** A probe's whole output into a status; `@@end` missing means the script did not finish. */
export function parseProbe(output: string, checkedAt: string): MachineStatus {
  const s = splitSections(output);
  if (!s.has("end")) return emptyStatus(checkedAt, "the probe script did not finish");
  const mem = parseMeminfo(s.get("meminfo") ?? "") ?? parseVmStat(s.get("vmstat") ?? "", num(s.get("memsize")));
  return {
    ...emptyStatus(checkedAt, null),
    cpuName: s.get("cpuname")?.split("\n")[0].trim() || null,
    cpus: num(s.get("nproc")),
    load1: parseLoad1(s.get("loadavg") ?? ""),
    memUsedBytes: mem?.used ?? null,
    memTotalBytes: mem?.total ?? null,
    gpus: parseNvidiaSmi(s.get("gpu") ?? ""),
    ollama: parseOllama(s.get("version"), s.get("ps")),
  };
}

export interface ProbeOptions {
  deadlineMs?: number;
  now?: () => Date;
}

/** One probe, read-only: the same script on stdin of `sh -s` here or over ssh, so both read the same way. */
export async function probeMachine(reach: Reach, port: number, options: ProbeOptions = {}): Promise<MachineStatus> {
  const host = reach === "local" ? null : requireSshTarget(reach.ssh);
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const run = { input: probeScript(port), deadlineMs, maxOutputBytes: MAX_PROBE_OUTPUT_BYTES };
  const r = host ? await runSsh(host, ["sh", "-s"], run) : await runProcess("sh", ["-s"], run);
  const failed = host
    ? sshFailure(r, host, deadlineMs)
    : r.spawnError
      ? `sh could not be started: ${r.spawnError}`
      : r.timedOut
        ? `the probe did not finish within ${deadlineMs / 1000}s.`
        : null;
  if (failed) return emptyStatus(checkedAt, failed);
  if (r.code !== 0) return emptyStatus(checkedAt, lastStderrLine(r.stderr) ?? `the probe exited with ${r.code}`);
  return parseProbe(r.stdout, checkedAt);
}
