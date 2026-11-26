// Local servers an agent started: processes under a pane's agent (or shell) process that listen on a TCP port.
// The pane shows them with an Open link and a Stop button. Only descendants of that pane's process are ever listed
// or signalled, and a Stop re-reads the process tree first, so a pid reused since the last poll is never hit.
//
// macOS and Linux: `ps -A -o pid=,ppid=,command=` for the tree, then `lsof -nP -a -iTCP -sTCP:LISTEN -p <pids> -Fpn`
// for the descendants only (a system-wide lsof is far slower). Linux without lsof falls back to `ss -Hltnp`.
// Windows: unsupported, the list stays empty.

import { execFile } from "node:child_process";
import type { AgentServer } from "../shared/ipc-types";
import { parseProcesses, type ProcessTable } from "./caller-proof";

export type { AgentServer };

export interface AgentServerDeps {
  /** `ps -A -o pid=,ppid=,command=` output, or null when ps cannot answer. `fresh`: not the table another caller
   *  read a moment ago (a Stop must see the tree as it is now). */
  ps(fresh?: boolean): Promise<string | null>;
  /** `lsof -Fpn` listen records for these pids ("" when none listen), or null when lsof is missing. */
  lsof(pids: number[]): Promise<string | null>;
  /** `ss -Hltnp` output, or null when ss is missing too. */
  ss(): Promise<string | null>;
  kill(pid: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
  /** Of these pids, the ones that have exited but are not reaped yet (ps state Z): `alive` still sees them. */
  zombies?(pids: number[]): Promise<Set<number>>;
  sleep(ms: number): Promise<void>;
}

export const STOP_GRACE_MS = 3_000;
const PROBE_TIMEOUT_MS = 2_000;
const TABLE_SHARE_MS = 1_000;
const MAX_COMMAND_CHARS = 400;
const MAX_LISTED_PIDS = 400;
/** One lsof covers every pane asking within this window. */
export const LIST_BATCH_MS = 150;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh"]);

/** A pane's root is a shell when the agent could not be exec'd in its place (a launcher function, a compound
 *  command): the shell's own children are then the agent itself. */
export function isShellCommand(command: string): boolean {
  const program = command.trim().split(/\s+/)[0] ?? "";
  return SHELLS.has(program.replace(/^-/, "").split("/").pop() ?? "");
}

/** Every descendant of `root` (root excluded), walking the ppid links of one snapshot. */
export function descendantsOf(root: number, table: ProcessTable): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) {
    if (pid === ppid) continue;
    const list = children.get(ppid);
    if (list) list.push(pid); else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child); out.push(child); stack.push(child);
    }
  }
  return out;
}

function portOf(address: string): number | null {
  const match = /:(\d{1,5})$/.exec(address.trim());
  const port = match ? Number(match[1]) : NaN;
  return port > 0 && port < 65536 ? port : null;
}

/** pid -> listening ports from `lsof -Fpn` field output ("p<pid>" opens a process, "n<addr>:<port>" a socket). */
export function parseLsofListeners(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith("n") && pid > 0) {
      const port = portOf(line.slice(1));
      if (port === null) continue;
      const ports = out.get(pid) ?? [];
      if (!ports.includes(port)) ports.push(port);
      out.set(pid, ports);
    }
  }
  return out;
}

/** pid -> listening ports from `ss -Hltnp`: local address in column 4, owners as `users:(("node",pid=12,fd=3))`. */
export function parseSsListeners(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const columns = line.trim().split(/\s+/);
    const port = columns.length >= 4 ? portOf(columns[3]) : null;
    if (port === null) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(match[1]);
      const ports = out.get(pid) ?? [];
      if (!ports.includes(port)) ports.push(port);
      out.set(pid, ports);
    }
  }
  return out;
}

function run(file: string, args: string[]): Promise<{ stdout: string; code: number | string | null }> {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      // A Finder-launched Electron can have a narrowed PATH; lsof and ss live in the sbin directories.
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/sbin:/sbin:/usr/bin:/bin` },
    }, (err, stdout) => resolve({ stdout: String(stdout ?? ""), code: err ? ((err as NodeJS.ErrnoException).code ?? 1) : 0 }));
  });
}

let sharedTable: { at: number; text: Promise<string | null> } | null = null;

export const systemDeps: AgentServerDeps = {
  ps: (fresh) => {
    // Several visible panes poll; one ps answers them all for a moment.
    if (!fresh && sharedTable && Date.now() - sharedTable.at < TABLE_SHARE_MS) return sharedTable.text;
    const text = run("ps", ["-A", "-o", "pid=,ppid=,command="]).then(({ stdout, code }) => code === 0 && stdout ? stdout : null);
    sharedTable = { at: Date.now(), text };
    return text;
  },
  lsof: async (pids) => {
    const { stdout, code } = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(","), "-Fpn"]);
    if (code === "ENOENT") return null;
    return stdout;   // exit 1 with no output: nothing listens
  },
  ss: async () => {
    const { stdout, code } = await run("ss", ["-Hltnp"]);
    return code === 0 ? stdout : null;
  },
  kill: (pid, signal) => process.kill(pid, signal),
  alive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
  },
  zombies: async (pids) => {
    const { stdout } = await run("ps", ["-o", "pid=,stat=", "-p", pids.join(",")]);
    const out = new Set<number>();
    for (const line of stdout.split("\n")) { const match = /^\s*(\d+)\s+(\S+)/.exec(line); if (match && match[2].startsWith("Z")) out.add(Number(match[1])); }
    return out;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The processes under `root` that may be listed and stopped: never the root, and when the root is a shell, not its
 *  own children either (the agent CLI, whose built-in servers and Stop would end the agent). */
async function tree(root: number, deps: AgentServerDeps, fresh = false): Promise<{ table: ProcessTable; descendants: number[] } | null> {
  const text = await deps.ps(fresh);
  const table = text ? parseProcesses(text) : null;
  return table ? treeIn(root, table) : null;
}

function treeIn(root: number, table: ProcessTable): { table: ProcessTable; descendants: number[] } | null {
  const entry = table.get(root);
  if (!entry) return null;
  const agents = isShellCommand(entry.command) ? new Set([...table].filter(([pid, p]) => p.ppid === root && pid !== root).map(([pid]) => pid)) : new Set<number>();
  return { table, descendants: descendantsOf(root, table).filter((pid) => !agents.has(pid)) };
}

const validRoot = (root: number | null | undefined): root is number => Number.isInteger(root) && (root as number) > 1 && process.platform !== "win32";

/** The listening servers under each root, from one ps and one lsof (or ss) for all of them. */
export async function listAgentServersFor(roots: readonly number[], deps: AgentServerDeps = systemDeps): Promise<Map<number, AgentServer[]>> {
  const out = new Map<number, AgentServer[]>(roots.map((root) => [root, []]));
  const valid = [...new Set(roots.filter(validRoot))];
  if (!valid.length) return out;
  const text = await deps.ps();
  const table = text ? parseProcesses(text) : null;
  if (!table) return out;
  const trees = new Map<number, number[]>();
  for (const root of valid) { const found = treeIn(root, table); if (found?.descendants.length) trees.set(root, found.descendants.slice(0, MAX_LISTED_PIDS)); }
  const pids = [...new Set([...trees.values()].flat())];
  if (!pids.length) return out;
  const lsof = await deps.lsof(pids);
  let listeners: Map<number, number[]>;
  if (lsof !== null) listeners = parseLsofListeners(lsof);
  else { const ss = await deps.ss(); listeners = ss ? parseSsListeners(ss) : new Map(); }
  for (const [root, under] of trees) {
    const servers: AgentServer[] = [];
    for (const pid of under) {
      const ports = listeners.get(pid);
      if (!ports?.length) continue;
      servers.push({ pid, command: (table.get(pid)?.command ?? "").slice(0, MAX_COMMAND_CHARS), ports: [...ports].sort((a, b) => a - b) });
    }
    out.set(root, servers.sort((a, b) => a.ports[0] - b.ports[0] || a.pid - b.pid));
  }
  return out;
}

/** The listening servers under `root`, by first port. Never the root itself: that is the agent (or shell). */
export async function listAgentServers(root: number | null | undefined, deps: AgentServerDeps = systemDeps): Promise<AgentServer[]> {
  if (!validRoot(root)) return [];
  return (await listAgentServersFor([root], deps)).get(root) ?? [];
}

/** listAgentServers for many panes polling at once: requests within `windowMs` share one ps and one lsof. */
export function batchedServerLister(deps: AgentServerDeps = systemDeps, windowMs = LIST_BATCH_MS): (root: number | null | undefined) => Promise<AgentServer[]> {
  let batch: Map<number, ((servers: AgentServer[]) => void)[]> | null = null;
  return (root) => {
    if (!validRoot(root)) return Promise.resolve([]);
    return new Promise((resolve) => {
      if (!batch) {
        const current = batch = new Map();
        setTimeout(() => {
          batch = null;
          void listAgentServersFor([...current.keys()], deps).catch(() => new Map<number, AgentServer[]>()).then((found) => {
            for (const [key, waiting] of current) for (const done of waiting) done(found.get(key) ?? []);
          });
        }, windowMs).unref?.();
      }
      const waiting = batch.get(root);
      if (waiting) waiting.push(resolve); else batch.set(root, [resolve]);
    });
  };
}

/** The lister every pane shares (terminal and Conversation GUI). */
export const listAgentServersBatched = batchedServerLister();

/** SIGTERM `pid` and its own children, then SIGKILL whatever is left after `graceMs`. Refuses a pid that is not,
 *  right now, a descendant of `root`. `forced` says whether SIGKILL was needed. */
export async function stopAgentServer(root: number | null | undefined, pid: number, deps: AgentServerDeps = systemDeps, graceMs = STOP_GRACE_MS): Promise<{ forced: boolean }> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid process id");
  const found = Number.isInteger(root) && (root as number) > 1 ? await tree(root as number, deps, true) : null;
  if (!found) throw new Error("The agent is not running, so Aya cannot tell which processes it started");
  if (!found.descendants.includes(pid)) throw new Error("That process is no longer running under this agent");
  const targets = [pid, ...descendantsOf(pid, found.table)];
  const signal = (sig: NodeJS.Signals, to: number[]) => { for (const target of to) { try { deps.kill(target, sig); } catch { /* already gone */ } } };
  // An exited process its parent has not reaped yet still answers kill(pid, 0); it is gone all the same.
  const living = async () => {
    const left = targets.filter((target) => deps.alive(target));
    if (!left.length || !deps.zombies) return left;
    const zombies = await deps.zombies(left).catch(() => new Set<number>());
    return left.filter((target) => !zombies.has(target));
  };
  signal("SIGTERM", targets);
  for (let waited = 0; waited < graceMs; waited += 100) {
    if (!(await living()).length) return { forced: false };
    await deps.sleep(100);
  }
  const left = await living();
  if (!left.length) return { forced: false };
  signal("SIGKILL", left);
  return { forced: true };
}

export function localServerUrl(port: unknown): string {
  if (!Number.isInteger(port) || (port as number) <= 0 || (port as number) >= 65536) throw new Error("Invalid port");
  return `http://localhost:${port}/`;
}
