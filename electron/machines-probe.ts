// Read-only probes of a machine for `aya machines` (docs/machines.md, step 1).

import { execFile, spawn } from "node:child_process";
import * as os from "node:os";

export const SSH_ALIAS_PATTERN = /^[A-Za-z0-9._-]+$/;
export const SSH_CONNECT_TIMEOUT_S = 5;
export const PROBE_DEADLINE_MS = 10_000;
/** The alias's config may add forwards (a public LocalForward), a LocalCommand or a shared master: a status probe gets none. */
export const SSH_OPTIONS = [
  "BatchMode=yes",
  `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
  "ClearAllForwardings=yes",
  "PermitLocalCommand=no",
  "ForwardAgent=no",
  "ForwardX11=no",
  "ControlMaster=no",
  "ControlPath=none",
  "Tunnel=no",
  "RequestTTY=no",
];
const OLLAMA_HTTP_TIMEOUT_MS = 3_000;
const LOCAL_TOOL_TIMEOUT_MS = 5_000;
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
  digest: string | null;
  vramBytes: number | null;
  expiresAt: string | null;
  pinned: boolean;
}

export interface OllamaState {
  up: boolean;
  version: string | null;
  loaded: LoadedModel[];
}

export interface MachineStatus {
  reachable: boolean;
  checkedAt: string;
  error: string | null;
  probeMs: number;
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

/** The remote script; sections are marked so a missing tool leaves an empty section, not a parse error. */
export function remoteProbeScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad Ollama port ${port}`);
  const url = `http://127.0.0.1:${port}`;
  return [
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

export function parseOllama(versionText: string | undefined, psText: string | undefined): OllamaState {
  const version = parseJson(versionText) as { version?: unknown } | null;
  const ps = parseJson(psText) as { models?: unknown } | null;
  const up = typeof version?.version === "string" || Array.isArray(ps?.models);
  const models = Array.isArray(ps?.models) ? (ps.models as Record<string, unknown>[]) : [];
  return {
    up,
    version: typeof version?.version === "string" ? version.version : null,
    loaded: models.map((m) => {
      const expiresAt = typeof m.expires_at === "string" ? m.expires_at : null;
      const year = expiresAt ? new Date(expiresAt).getUTCFullYear() : NaN;
      return {
        name: String(m.name ?? m.model ?? "?"),
        digest: typeof m.digest === "string" ? m.digest : null,
        vramBytes: typeof m.size_vram === "number" ? m.size_vram : null,
        expiresAt,
        pinned: year > PINNED_AFTER_YEAR,
      };
    }),
  };
}

const emptyStatus = (checkedAt: string, probeMs: number, error: string | null): MachineStatus => ({
  reachable: error === null,
  checkedAt,
  error,
  probeMs,
  cpus: null,
  load1: null,
  memUsedBytes: null,
  memTotalBytes: null,
  gpus: [],
  ollama: { up: false, version: null, loaded: [] },
});

/** A remote probe's whole output into a status; `@@end` missing means the script did not finish. */
export function parseRemoteProbe(output: string, checkedAt: string, probeMs: number): MachineStatus {
  const s = splitSections(output);
  if (!s.has("end")) return emptyStatus(checkedAt, probeMs, "the probe script did not finish");
  const mem = parseMeminfo(s.get("meminfo") ?? "") ?? parseVmStat(s.get("vmstat") ?? "", num(s.get("memsize")));
  return {
    ...emptyStatus(checkedAt, probeMs, null),
    cpus: num(s.get("nproc")),
    load1: parseLoad1(s.get("loadavg") ?? ""),
    memUsedBytes: mem?.used ?? null,
    memTotalBytes: mem?.total ?? null,
    gpus: parseNvidiaSmi(s.get("gpu") ?? ""),
    ollama: parseOllama(s.get("version"), s.get("ps")),
  };
}

/** The last stderr line ssh printed, which names the reason (timeout, auth, unknown host). */
export function sshError(stderr: string, code: number | null): string {
  const line = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return line ? `ssh: ${line.replace(/^ssh:\s*/, "")}` : `ssh exited with ${code}`;
}

/** Runs `cmd` with `input` on stdin; settles on exit or kills it at the deadline. */
function runWithDeadline(cmd: string, args: string[], input: string, deadlineMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      // Own process group: a ProxyCommand child holding our pipes dies with ssh at the deadline.
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (err) {
      resolve({ code: null, stdout, stderr: String(err), timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      // A grandchild outside the group may still hold the pipes: answer now, not at their close.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code: null, stdout, stderr, timedOut });
    }, deadlineMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_PROBE_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_PROBE_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.stdin?.on("error", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: err.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.end(input);
  });
}

export interface ProbeOptions {
  deadlineMs?: number;
  now?: () => Date;
}

export async function probeRemote(alias: string, port: number, options: ProbeOptions = {}): Promise<MachineStatus> {
  if (!SSH_ALIAS_PATTERN.test(alias)) throw new Error(`"${alias}" is not a valid ssh alias`);
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  const started = Date.now();
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const args = [...SSH_OPTIONS.flatMap((o) => ["-o", o]), "--", alias, "sh", "-s"];
  const r = await runWithDeadline("ssh", args, remoteProbeScript(port), deadlineMs);
  const probeMs = Date.now() - started;
  if (r.timedOut) return emptyStatus(checkedAt, probeMs, `timed out after ${deadlineMs / 1000} s`);
  if (r.code !== 0) return emptyStatus(checkedAt, probeMs, sshError(r.stderr, r.code));
  return parseRemoteProbe(r.stdout, checkedAt, probeMs);
}

function execText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: LOCAL_TOOL_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function getText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OLLAMA_HTTP_TIMEOUT_MS) });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

async function probeLocalOnce(port: number, checkedAt: string, started: number): Promise<MachineStatus> {
  const base = `http://127.0.0.1:${port}`;
  const [gpuText, vmStat, version, ps] = await Promise.all([
    execText("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"]),
    process.platform === "darwin" ? execText("vm_stat", []) : Promise.resolve(null),
    getText(`${base}/api/version`),
    getText(`${base}/api/ps`),
  ]);
  const total = os.totalmem();
  // os.freemem on macOS counts only free pages; vm_stat gives what Activity Monitor calls used.
  const mem = (vmStat && parseVmStat(vmStat, total)) || { used: total - os.freemem(), total };
  return {
    ...emptyStatus(checkedAt, 0, null),
    cpus: os.cpus().length,
    load1: os.loadavg()[0],
    memUsedBytes: mem.used,
    memTotalBytes: mem.total,
    gpus: gpuText ? parseNvidiaSmi(gpuText) : [],
    ollama: parseOllama(version, ps),
    probeMs: Date.now() - started,
  };
}

export async function probeLocal(port: number, options: ProbeOptions = {}): Promise<MachineStatus> {
  const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
  const started = Date.now();
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<MachineStatus>((resolve) => {
    timer = setTimeout(() => resolve(emptyStatus(checkedAt, Date.now() - started, `timed out after ${deadlineMs / 1000} s`)), deadlineMs);
  });
  try {
    return await Promise.race([probeLocalOnce(port, checkedAt, started), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function probeMachine(reach: Reach, port: number, options: ProbeOptions = {}): Promise<MachineStatus> {
  return reach === "local" ? probeLocal(port, options) : probeRemote(reach.ssh, port, options);
}
