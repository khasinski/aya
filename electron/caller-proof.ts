// A pane id in a command's env is a claim, not proof: Codex's shared app-server daemon (0.159.2, measured) runs every
// pane's commands with the env of the pane that started it. A command that really runs in a pane descends from its process.

import { execFile } from "node:child_process";
import { COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import type { ControlCaller } from "./control-protocol";
import { firstPositional } from "./codex-daemon";

export const MAX_DEPTH = 256;
export const TABLE_SHARE_MS = 200;

export type ProcessTable = Map<number, { ppid: number; command: string }>;

/** pid -> parent and argv from `ps -A -o pid=,ppid=,command=` output. */
export function parseProcesses(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3].trim() });
  }
  return table;
}

// A busy machine lists well over execFile's default 1 MB.
export const PS_TABLE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const PS_OPTIONS = { timeout: COMMAND_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: PS_TABLE_MAX_BUFFER_BYTES };

/** The whole process table, or null when `ps` cannot answer (then nothing is refused). */
export function readProcessTable(): Promise<ProcessTable | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,command="], PS_OPTIONS, (err, stdout) => {
      const table = err ? null : parseProcesses(String(stdout));
      resolve(table && table.size > 0 ? table : null);
    });
  });
}

// Codex's TUI forks the shared daemon as its own child (0.159.2): its commands sit under the starter pane. Only the
// argv's structure counts (codex, or node/npx running it, then `app-server`), never text like a message to `aya`.
const LAUNCHERS = new Set(["node", "nodejs", "npx", "bunx"]);
const CODEX_WORD = /(?:^|\/)codex(?:\.js)?$/;

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function isCodexAppServer(command: string): boolean {
  const words = command.split(/\s+/);
  let first = 1;
  if (basename(words[0]) !== "codex") {
    if (!LAUNCHERS.has(basename(words[0]))) return false;
    // the script path may hold spaces, so it ends at the first word that is named codex
    const at = words.findIndex((word, i) => i > 0 && !word.startsWith("-") && CODEX_WORD.test(word));
    if (at < 0) return false;
    first = at + 1;
  }
  return firstPositional(words.slice(first)) === "app-server";
}

function* ancestry(start: number | undefined, table: ProcessTable): Generator<number> {
  for (let at = start, depth = 0; at !== undefined && at > 1 && depth < MAX_DEPTH; depth += 1) {
    yield at;
    at = table.get(at)?.ppid;
  }
}

function readParent(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=", "-p", String(pid)], PS_OPTIONS, (err, stdout) => {
      const ppid = Number.parseInt(String(stdout), 10);
      resolve(err || !Number.isFinite(ppid) ? null : ppid);
    });
  });
}

export interface TableSource {
  readTable: () => Promise<ProcessTable | null>;
  readPpid: (pid: number) => Promise<number | null>;
  now: () => number;
}
const LIVE_SOURCE: TableSource = { readTable: readProcessTable, readPpid: readParent, now: Date.now };

let recent: { at: number; read: Promise<ProcessTable | null> } | null = null;

/** The table with `pid` in it: a read in flight or finished within TABLE_SHARE_MS is shared by a burst of
 *  requests while `pid` still has the parent that read shows, else the table is read again. */
export async function processTable(pid: number, source: TableSource = LIVE_SOURCE): Promise<ProcessTable | null> {
  if (recent && source.now() - recent.at < TABLE_SHARE_MS) {
    const table = await recent.read;
    const cached = table?.get(pid);
    if (cached && (await source.readPpid(pid)) === cached.ppid) return table;
  }
  const entry = { at: source.now(), read: source.readTable() };
  void entry.read.then(() => {
    entry.at = source.now();
  });
  recent = entry;
  return entry.read;
}

/** The refusal when the caller does not run under its pane's process (`panePid` null: none), or runs under a Codex
 *  app-server on the way; else null, also where nothing can be proven (older CLI, unknown pid). */
export function unprovenIdentity(
  { terminalId, pid }: ControlCaller,
  panePid: number | null,
  table: ProcessTable,
): string | null {
  if (!pid || !table.has(pid)) return null;
  if (panePid === null) {
    return `${terminalId} is not running; the command comes from a leftover daemon or job, so it cannot speak as that pane. Run it from a pane that is running`;
  }
  let daemon = false;
  for (const at of ancestry(pid, table)) {
    const proc = table.get(at);
    if (!proc) break;
    // the caller is the aya CLI itself, whose argv carries user text; only its ancestors are judged
    if (at !== pid && isCodexAppServer(proc.command)) {
      daemon = true;
      break;
    }
    if (at === panePid) return null;
  }
  return unprovenMessage(terminalId, daemon);
}

function unprovenMessage(terminalId: string | undefined, daemon: boolean): string {
  const why = daemon
    ? "it comes from a Codex daemon (restart the pane with --no-daemon)"
    : "it is another pane's command or a job left running after its tool finished";
  return (
    `the identity of this command (AYA_TERMINAL_ID=${terminalId}) cannot be proven to come from this pane: the command did not run under this pane's process. ` +
    `That happens when ${why}. Run it from the pane's own shell`
  );
}

/** The refusal when the caller's process runs under a pane other than the one its id names: a hand-set id
 *  would act as that pane's role. A process under no pane (a script, the e2e suite) is not refused. */
export function foreignPaneIdentity(terminalId: string | undefined, under: string | null): string | null {
  return terminalId && under && under !== terminalId ? unprovenMessage(terminalId, false) : null;
}

/** The refusal when the caller runs under a Codex app-server: that shared daemon gives every pane's commands the
 *  env of the pane that started it, another project's included, so its pane id names no pane. Else null. */
export function daemonIdentity({ terminalId, pid }: ControlCaller, table: ProcessTable): string | null {
  if (!terminalId || !pid) return null;
  for (const at of ancestry(table.get(pid)?.ppid, table)) {
    if (isCodexAppServer(table.get(at)?.command ?? "")) return unprovenMessage(terminalId, true);
  }
  return null;
}

/** The pane whose process `pid` runs under (the nearest one up its process tree), else null.
 *  Unlike a pane id in the env, this cannot be left out by unsetting a variable. */
export function paneAbove(pid: number, table: ProcessTable, panePids: ReadonlyMap<number, string>): string | null {
  for (const at of ancestry(pid, table)) {
    const pane = panePids.get(at);
    if (pane) return pane;
  }
  return null;
}
