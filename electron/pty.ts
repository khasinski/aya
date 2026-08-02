// PTY host. One IPty per ptyId, all events forwarded to the renderer.
//
// We accept a literal `command` string from the renderer and wrap it in
// `$SHELL -l -i -c 'cd CWD && exec COMMAND'`. Using the user's login +
// interactive shell — not a hard-coded bash — lets PATH, functions, aliases,
// and env from their normal terminal startup files flow through.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type * as PtyModule from "node-pty";
import type { PtyEvent, SpawnFailureReason, SpawnRequest } from "./types";
import { AYA_HOME, CONTROL_SOCKET_PATH } from "./paths";
import { COMMAND_NOT_FOUND_EXIT_CODE, COMMAND_PROBE_TIMEOUT_MS } from "./constants";
import { userShell } from "./shell";
import { ptyLog } from "./pty-log";

// Timeout for the shell `command -v` existence check during spawn preflight.

// Minimum PTY dimensions clamped before spawn/resize (node-pty needs >0).
const MIN_PTY_COLS = 4; // minimum PTY columns
const MIN_PTY_ROWS = 2; // minimum PTY rows
// Search-snippet context window around a match (chars).
const SEARCH_SNIPPET_CONTEXT_BEFORE = 30; // chars before the match
const SEARCH_SNIPPET_CONTEXT_AFTER = 50; // chars after the match
// Stop counting occurrences past this many (snippet "more" cap).
const SEARCH_MAX_COUNT_DISPLAY = 99;

let nodePty: typeof PtyModule | null = null;

function loadNodePty(): typeof PtyModule {
  if (!nodePty) {
    nodePty = require("node-pty") as typeof PtyModule;
  }
  return nodePty;
}

const ptys = new Map<string, PtyModule.IPty>();

// Per-PTY rolling buffer of recent output, used to repaint xterm.js when the
// renderer remounts (Vite HMR, React strict-mode double-mount, etc.). The PTY
// keeps running across these events but the new xterm.js instance has no
// scrollback — we replay the buffered bytes so the user sees the existing
// terminal state instead of an empty pane.
export const OUTPUT_BUFFER_MAX = 1_000_000; // ~1MB of recent bytes per terminal
// `total` is the summed length of `chunks`, kept incrementally so the 1MB cap
// is enforced in O(1) per chunk instead of re-summing the whole buffer (which
// was O(chunks) per chunk → O(n²) over a busy session).
interface OutputBuffer {
  chunks: string[];
  total: number;
  /** Monotonic append counter; invalidates searchCache below. (`total` alone
   *  is not a safe key: cap eviction can shrink and regrow it to the same
   *  value with different content.) */
  version: number;
  /** Cleaned + lowercased render of `chunks`, reused across search keystrokes
   *  so an unchanged buffer costs indexOf scans instead of a full join + 4
   *  regex passes + toLowerCase over ~1MB per live PTY per keystroke. */
  searchCache?: { version: number; cleaned: string; lower: string };
}
const outputBuffers = new Map<string, OutputBuffer>();

// Spawn/kill race guard: if killPty arrives before the corresponding
// spawnPty's IPC has finished (renderer remounted/closed quickly), the kill
// finds no IPty in the map and is a no-op. The pending spawn then runs and
// the resulting PTY is orphaned. We remember which ptyIds got an early kill
// and bail out of subsequent spawn for them.
const pendingKills = new Set<string>();
// Auto-evict pending-kill markers so stale ids don't linger forever (defense
// in depth — usually the spawn either runs within milliseconds or never).
const PENDING_KILL_TTL_MS = 5_000;
// Grace period before escalating a kill to SIGKILL. node-pty's default kill
// sends SIGHUP, which a stuck agent (e.g. `claude --chrome`) can trap and
// survive; since killPty removes the id from the map, a survivor becomes an
// orphan that a later respawn of the same id turns into a SECOND live process.
// The uncatchable follow-up guarantees the old child actually dies.
export const KILL_ESCALATE_MS = 750;
// In-flight spawn guard: spawnPty awaits an async command-exists preflight
// between the `ptys.has` check and registering the PTY. Two concurrent spawns
// for the same id (e.g. a fast unmount+remount) could both pass that check and
// both spawn, orphaning the first. We mark an id as spawning across the await
// so a racing call bails instead of starting a second process.
const spawning = new Set<string>();
// Set once the host begins shutting down. shutdownPtyChildren snapshots the live
// PTYs and the host then lingers up to KILL_ESCALATE_MS to deliver SIGKILL; a
// spawn that registered a PTY in that window would escape the snapshot and be
// orphaned on exit. spawnPty bails when this is set (and again after its async
// preflight) so no child is created after the snapshot. One-way: the host is
// exiting, so it never resets.
let shuttingDown = false;

export interface PtyEventSink {
  isDestroyed(): boolean;
  sendPtyEvent(event: PtyEvent): void;
}

function appendToOutputBuffer(ptyId: string, chunk: string): void {
  let buffer = outputBuffers.get(ptyId);
  if (!buffer) {
    buffer = { chunks: [], total: 0, version: 0 };
    outputBuffers.set(ptyId, buffer);
  }
  buffer.chunks.push(chunk);
  buffer.total += chunk.length;
  buffer.version += 1;
  while (buffer.total > OUTPUT_BUFFER_MAX && buffer.chunks.length > 1) {
    const removed = buffer.chunks.shift();
    if (removed) buffer.total -= removed.length;
  }
}

export function __testAppendToOutputBuffer(ptyId: string, chunk: string): void {
  appendToOutputBuffer(ptyId, chunk);
}

export function __testClearOutputBuffers(): void {
  outputBuffers.clear();
}

export function getBufferedOutput(ptyId: string): string {
  const buffer = outputBuffers.get(ptyId);
  return buffer ? buffer.chunks.join("") : "";
}

/** Strip ANSI escape sequences and control chars so search snippets are
 *  readable. Keeps newlines so line context survives. Exported for unit tests.
 *
 *  DUPLICATE: a near-identical copy lives in src/bell.ts (renderer process,
 *  which can't import this main-process module). Keep the escape-sequence rules
 *  in sync — the only intended difference is the trailing control-char strip,
 *  which bell.ts omits. (The ST-OSC leak this fixes had to be patched in both;
 *  one was nearly missed.) */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // DCS / PM / APC / SOS (ESC P/X/^/_ … ST) BEFORE OSC, so the OSC rule below
    // can't steal a DCS string's ST terminator and orphan its introducer.
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "")
    // OSC: terminated by BEL or ST (ESC \). Matching only BEL leaked the title
    // payload of ST-terminated sequences into search snippets.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface BufferSearchHit {
  ptyId: string;
  /** Cleaned snippet around the first occurrence (~80 chars total). */
  snippet: string;
  /** Position of the match within the cleaned snippet, for highlighting. */
  matchStart: number;
  matchLength: number;
  /** Approximate number of additional occurrences beyond the first. */
  more: number;
}

/** Case-insensitive AND-search across all live PTY buffers. The query is
 *  split into whitespace-delimited tokens; every token must appear in the
 *  buffer for that buffer to count as a hit. Snippet is built around the
 *  first-occurring token (so user sees relevant context for whichever
 *  word matched earliest). */
export function searchPtyOutputs(query: string): BufferSearchHit[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const hits: BufferSearchHit[] = [];
  for (const [ptyId, buffer] of outputBuffers) {
    // Re-clean only buffers that changed since the last query; while the user
    // types, the typical buffer is static and this is a cache hit.
    let cache = buffer.searchCache;
    if (!cache || cache.version !== buffer.version) {
      const freshCleaned = stripAnsi(buffer.chunks.join(""));
      cache = {
        version: buffer.version,
        cleaned: freshCleaned,
        lower: freshCleaned.toLowerCase(),
      };
      buffer.searchCache = cache;
    }
    const { cleaned, lower } = cache;
    // Every token must be present somewhere.
    const tokenIdxs: Array<{ idx: number; len: number }> = [];
    let allFound = true;
    for (const tok of tokens) {
      const idx = lower.indexOf(tok);
      if (idx < 0) {
        allFound = false;
        break;
      }
      tokenIdxs.push({ idx, len: tok.length });
    }
    if (!allFound) continue;
    // Snippet centered on the earliest-occurring token so the user sees
    // useful context regardless of which word in their query matched first.
    const earliest = tokenIdxs.reduce(
      (best, t) => (t.idx < best.idx ? t : best),
      tokenIdxs[0],
    );
    const start = Math.max(0, earliest.idx - SEARCH_SNIPPET_CONTEXT_BEFORE);
    const end = Math.min(
      cleaned.length,
      earliest.idx + earliest.len + SEARCH_SNIPPET_CONTEXT_AFTER,
    );
    const snippet = cleaned.slice(start, end).replace(/\s+/g, " ").trim();
    const matchStartInSnippet = Math.max(
      0,
      snippet.toLowerCase().indexOf(tokens[tokenIdxs.indexOf(earliest)]),
    );
    // Count additional occurrences of any token across the buffer.
    let more = -1; // we'll add 1 for the highlighted match below
    for (const tok of tokens) {
      let from = 0;
      while (from < lower.length) {
        const next = lower.indexOf(tok, from);
        if (next < 0) break;
        more += 1;
        from = next + tok.length;
        if (more > SEARCH_MAX_COUNT_DISPLAY) break;
      }
      if (more > SEARCH_MAX_COUNT_DISPLAY) break;
    }
    hits.push({
      ptyId,
      snippet,
      matchStart: matchStartInSnippet,
      matchLength: earliest.len,
      more: Math.max(0, more),
    });
  }
  return hits;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function endOfShellToken(s: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) return i;
  }
  return s.length;
}

function commandWithExec(command: string): string {
  const start = command.search(/\S/);
  if (start < 0) return "exec";
  let pos = start;
  let assignmentEnd = start;
  let sawAssignment = false;

  while (pos < command.length) {
    const tokenEnd = endOfShellToken(command, pos);
    const token = command.slice(pos, tokenEnd);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
    sawAssignment = true;
    assignmentEnd = tokenEnd;
    pos = tokenEnd;
    while (pos < command.length && /\s/.test(command[pos])) pos += 1;
  }

  if (!sawAssignment) return `exec ${command}`;
  if (pos >= command.length) return command;
  const executable = command.slice(pos);
  return `${command.slice(0, assignmentEnd)} exec ${commandForExec(executable)}`;
}

function commandForExec(command: string): string {
  const trimmed = command.trim();
  if (trimmed === "$SHELL") {
    return "env -u EDITOR -u VISUAL $SHELL";
  }
  return command;
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\\(.)/g, "$1");
}

function expandConfigDir(value: string): string {
  const home = os.homedir();
  const unquoted = unquoteEnvValue(value.trim());
  return path.resolve(
    unquoted
      .replace(/^~(?=\/|$)/, home)
      .replace(/^\$HOME(?=\/|$)/, home)
      .replace(/^\$\{HOME\}(?=\/|$)/, home),
  );
}

export function agentConfigDirsFromCommand(command: string): string[] {
  const dirs: string[] = [];
  let pos = command.search(/\S/);
  if (pos < 0) return dirs;

  while (pos < command.length) {
    const tokenEnd = endOfShellToken(command, pos);
    const token = command.slice(pos, tokenEnd);
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) break;
    const key = match[1];
    if (key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR") {
      const dir = expandConfigDir(match[2]);
      if (dir) dirs.push(dir);
    }
    pos = tokenEnd;
    while (pos < command.length && /\s/.test(command[pos])) pos += 1;
  }

  return dirs;
}

/** Build the shell argv for a given command + cwd. Uses the user's login +
 *  interactive shell so PATH/env/functions from their rc files (zsh, fish,
 *  bash, etc.) flow through. Many user launchers are shell functions or PATH
 *  edits in .zshrc/.bashrc, which login-only non-interactive shells skip. */
export function shellArgv(command: string, cwd: string): string[] {
  const cwdQuoted = shellQuote(cwd);
  // The user's command is embedded verbatim so $VARS / quoting / pipes work.
  // It must NOT be shell-quoted, or the shell would treat the whole thing
  // as one literal token.
  return [userShell(), "-l", "-i", "-c", `cd ${cwdQuoted} && ${commandWithExec(commandForExec(command))}`];
}

/** Friendly error reporter — writes a red banner into the terminal and emits
 *  a synthetic exit so the host knows the spawn never happened. */
function reportSpawnFailure(
  sink: PtyEventSink,
  ptyId: string,
  reason: SpawnFailureReason,
  message: string,
): void {
  // Log BEFORE the destroyed-sink bail: the failure happened either way, and
  // a failure nobody could see is exactly what the forensic log is for.
  ptyLog.append("spawn-failed", { ptyId, reason });
  if (sink.isDestroyed()) return;
  const banner = `\r\n\x1b[1;31maya: \x1b[0m\x1b[31m${message}\x1b[0m\r\n\r\n`;
  sink.sendPtyEvent({ type: "spawn-failed", ptyId, reason, detail: message });
  sink.sendPtyEvent({ type: "data", ptyId, chunk: banner });
  sink.sendPtyEvent({ type: "exit", ptyId, exitCode: COMMAND_NOT_FOUND_EXIT_CODE });
}

function preflightBinary(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (
    /(^|\s)[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) ||
    /[|&;<>(){}[\]*?~$`"'\\]/.test(trimmed)
  ) {
    return null;
  }
  const [binary] = trimmed.split(/\s+/);
  return /^[a-zA-Z0-9_.-]+$/.test(binary) ? binary : null;
}

// The probe spawns a full login+interactive shell (oh-my-zsh startup can be
// hundreds of ms), and it runs before EVERY non-shell spawn for the same few
// binaries. A found binary effectively never disappears mid-session, so cache
// positives for the process lifetime; misses stay uncached so installing a
// tool mid-session is picked up by the next spawn.
const commandExistsCache = new Set<string>();

async function commandExists(binary: string): Promise<boolean> {
  if (commandExistsCache.has(binary)) return true;
  const found = await new Promise<boolean>((resolve) => {
    execFile(
      userShell(),
      ["-l", "-i", "-c", `command -v -- ${binary} >/dev/null 2>&1`],
      { timeout: COMMAND_PROBE_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(err === null),
    );
  });
  if (found) commandExistsCache.add(binary);
  return found;
}

function safeEnv(req: SpawnRequest, cwd: string): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  if (!out.LANG) out.LANG = "en_US.UTF-8";
  if (!out.LC_ALL) out.LC_ALL = out.LANG;
  out.AYA_HOME = AYA_HOME;
  out.AYA_SOCKET = CONTROL_SOCKET_PATH;
  out.AYA_TERMINAL_ID = req.ptyId;
  out.AYA_PROJECT_DIR = cwd;
  if (req.projectSlug) out.AYA_PROJECT_SLUG = req.projectSlug;
  if (req.presetId) out.AYA_PRESET_ID = req.presetId;
  return out;
}

export async function spawnPty(req: SpawnRequest, sink: PtyEventSink): Promise<void> {
  if (shuttingDown) {
    // The host is tearing down; a new PTY here would miss the shutdown snapshot
    // and be orphaned on exit. Drop the spawn.
    ptyLog.append("spawn-dropped-shutting-down", { ptyId: req.ptyId });
    return;
  }
  if (pendingKills.has(req.ptyId)) {
    // killPty arrived before this spawn (the renderer closed the tab between
    // mounting and the IPC round-trip). Drop the spawn so we don't orphan a
    // process the user already asked to discard.
    pendingKills.delete(req.ptyId);
    ptyLog.append("spawn-dropped-pending-kill", { ptyId: req.ptyId });
    return;
  }
  if (ptys.has(req.ptyId)) {
    // Already running — this is a re-mount (Vite HMR or a React double-mount).
    // Don't spawn again; replay the buffered output so the freshly-created
    // xterm.js can repaint the existing scrollback. The PTY's own onData
    // continues to deliver new bytes to the renderer.
    const buffered = getBufferedOutput(req.ptyId);
    ptyLog.append("spawn-replay", {
      ptyId: req.ptyId,
      bytes: Buffer.byteLength(buffered),
    });
    if (buffered && !sink.isDestroyed()) {
      sink.sendPtyEvent({
        type: "data",
        ptyId: req.ptyId,
        chunk: buffered,
        replay: true,
      });
    }
    return;
  }
  if (spawning.has(req.ptyId)) {
    // A spawn for this id is already in flight (a concurrent re-mount got here
    // first, before it could register its PTY). Bail BEFORE the attachOnly
    // branch: the in-flight spawn owns the session and will stream to the
    // renderer, so emitting no-session here would falsely strand the tab as
    // stopped. (Checked before attachOnly so the host is robust regardless of
    // the renderer's confirmed-output gating.)
    ptyLog.append("spawn-dropped-in-flight", { ptyId: req.ptyId });
    return;
  }
  if (req.attachOnly) {
    // Re-mount of a tab that already ran this session, but its PTY is gone (the
    // process died while the host stayed up). Don't silently start a fresh
    // process - tell the renderer so it can show a stopped/restartable state.
    ptyLog.append("no-session", { ptyId: req.ptyId });
    if (!sink.isDestroyed()) {
      sink.sendPtyEvent({ type: "no-session", ptyId: req.ptyId });
    }
    return;
  }
  const cwd = path.resolve(req.cwd.replace(/^~/, os.homedir()));

  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "cwd-not-directory",
        `not a directory: ${cwd}\nEdit the project to fix this, or close it.`,
      );
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "cwd-missing",
        `directory does not exist: ${cwd}\nClose the project (top-bar ✕) to clean up.`,
      );
      return;
    }
    reportSpawnFailure(
      sink,
      req.ptyId,
      "cwd-unreadable",
      `cannot read ${cwd}: ${String(err)}`,
    );
    return;
  }

  if (!req.command || !req.command.trim()) {
    reportSpawnFailure(
      sink,
      req.ptyId,
      "preset-empty-command",
      `preset has no command — edit it in Settings.`,
    );
    return;
  }

  for (const dir of agentConfigDirsFromCommand(req.command)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "agent-config-dir-create-failed",
        `cannot create agent config directory: ${dir}\n${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  const binary = preflightBinary(req.command);
  // Mark this id in-flight across the async preflight + spawn so a concurrent
  // call bails at the guard above. (The bail itself lives before the attachOnly
  // branch; here we only claim the marker, synchronously before the first await
  // so no racing call can interleave before it is set.)
  spawning.add(req.ptyId);
  try {
    if (binary && !(await commandExists(binary))) {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "command-not-found",
        `command not found: ${binary}\nEdit the preset, install the CLI, or re-scan installed CLIs.`,
      );
      return;
    }

    const argv = shellArgv(req.command, cwd);
    const file = argv[0];
    const args = argv.slice(1);

    let child: PtyModule.IPty;
    try {
      child = loadNodePty().spawn(file, args, {
        name: "xterm-256color",
        cols: Math.max(req.cols, MIN_PTY_COLS),
        rows: Math.max(req.rows, MIN_PTY_ROWS),
        cwd,
        env: safeEnv(req, cwd),
      });
    } catch (err) {
      reportSpawnFailure(
        sink,
        req.ptyId,
        "node-pty-spawn-error",
        `failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (shuttingDown) {
      // Shutdown began during our async preflight, after the snapshot was taken.
      // Registering now would orphan this child, and a scheduled escalation might
      // not fire before the host exits - so force-kill it synchronously (the
      // SIGKILL syscall dooms it regardless of the host's remaining lifetime).
      child.onExit(({ exitCode }) => {
        ptyLog.append("exit", { ptyId: req.ptyId, exitCode, killed: true });
      });
      try {
        child.kill();
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      ptyLog.append("spawn-killed-on-shutdown", { ptyId: req.ptyId });
      return;
    }

    ptys.set(req.ptyId, child);
    // The command is logged verbatim: it is the single most diagnostic field
    // (e.g. did this respawn carry --continue?), and it is already stored in
    // plaintext in ~/.aya/presets.json - the log adds no new exposure.
    ptyLog.append("spawn", {
      ptyId: req.ptyId,
      childPid: child.pid,
      projectSlug: req.projectSlug,
      presetId: req.presetId,
      cwd,
      // Clamped: the command is unbounded user input, and a single line
      // larger than the log cap would blow straight past it (#89). 4 KB
      // keeps every realistic command (and its resume arg) intact.
      command: req.command.slice(0, 4096),
    });

    child.onData((chunk) => {
      appendToOutputBuffer(req.ptyId, chunk);
      if (sink.isDestroyed()) return;
      sink.sendPtyEvent({ type: "data", ptyId: req.ptyId, chunk });
    });

    child.onExit(({ exitCode }) => {
      if (ptys.get(req.ptyId) !== child) {
        return;
      }
      ptys.delete(req.ptyId);
      outputBuffers.delete(req.ptyId);
      ptyLog.append("exit", { ptyId: req.ptyId, exitCode });
      if (sink.isDestroyed()) return;
      sink.sendPtyEvent({ type: "exit", ptyId: req.ptyId, exitCode });
    });
  } finally {
    spawning.delete(req.ptyId);
  }
}

export function writePty(ptyId: string, data: string): void {
  const p = ptys.get(ptyId);
  if (!p) return;
  p.write(data);
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  const p = ptys.get(ptyId);
  if (!p) return;
  try {
    p.resize(Math.max(cols, MIN_PTY_COLS), Math.max(rows, MIN_PTY_ROWS));
  } catch {
    // ignore — pty may have just exited
  }
}

/** Kill a PTY child, escalating to SIGKILL after a grace period. The graceful
 *  signal lets a well-behaved process exit and clean up; the SIGKILL guarantees
 *  a signal-ignoring one (e.g. `claude --chrome`) actually dies, so it can't
 *  linger as an orphan after killPty removes it from the map (which would let a
 *  respawn of the same id create a second live process). Exported for tests;
 *  `schedule` is injectable so the escalation can be exercised synchronously. */
export function terminatePtyChild(
  p: Pick<PtyModule.IPty, "kill">,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): void {
  try {
    p.kill();
  } catch {
    // already gone
  }
  schedule(() => {
    try {
      p.kill("SIGKILL");
    } catch {
      // already exited — nothing to force-kill
    }
  }, KILL_ESCALATE_MS);
}

export function killPty(ptyId: string): void {
  outputBuffers.delete(ptyId);
  const p = ptys.get(ptyId);
  ptyLog.append("kill", { ptyId, live: !!p });
  if (!p) {
    // No PTY for this id yet — either it never existed, or the spawn IPC is
    // still in flight. Mark it so a late-arriving spawnPty bails out. The
    // TTL evicts the marker if nothing comes (cleaner than leaking ids).
    pendingKills.add(ptyId);
    setTimeout(() => pendingKills.delete(ptyId), PENDING_KILL_TTL_MS);
    return;
  }
  // Remove from the map first (a re-mount/respawn should not attach to a dying
  // PTY), then terminate with SIGKILL escalation so a signal-ignoring child
  // can't survive and get orphaned.
  ptys.delete(ptyId);
  // The spawn-time onExit skips its "exit" append once the map entry is gone
  // (its identity guard exists so a respawn under the same id is not wrongly
  // torn down) - so log the killed child's actual exit here, or the forensic
  // trail shows a kill with no evidence the child ever died (#88).
  p.onExit(({ exitCode }) => {
    ptyLog.append("exit", { ptyId, exitCode, killed: true });
  });
  terminatePtyChild(p);
}

/** Graceful shutdown of a set of PTY children, event-driven with a hard deadline
 *  (the graceful->timeout->SIGKILL ladder of systemd/k8s/docker, but resolving
 *  as soon as the children are actually dead so a clean quit isn't delayed by a
 *  fixed timer). Sends the graceful signal to each, calls `onDone` once the last
 *  child exits, and at the KILL_ESCALATE_MS deadline force-kills any survivor
 *  (the SIGKILL syscall dooms it regardless of whether this host outlives it)
 *  before resolving. Split from `shutdownPtyChildren` so the loop is unit-testable
 *  with fake children; `schedule` is injectable. `onDone` fires exactly once. */
export function shutdownChildren(
  children: Array<Pick<PtyModule.IPty, "kill" | "onExit">>,
  onDone: () => void,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onDone();
  };

  if (children.length === 0) {
    // Defer so a caller returning a response can flush before the process exits.
    schedule(finish, 0);
    return;
  }

  let remaining = children.length;
  const settleOne = () => {
    remaining -= 1;
    if (remaining <= 0) finish();
  };

  for (const p of children) {
    try {
      p.onExit(() => settleOne());
    } catch {
      // Can't observe this child's exit — let the deadline cover it.
    }
    try {
      p.kill(); // graceful first; a well-behaved child exits and triggers onExit
    } catch {
      settleOne(); // already gone — counts as settled
    }
  }

  schedule(() => {
    for (const p of children) {
      try {
        p.kill("SIGKILL");
      } catch {
        // already exited — nothing to force-kill
      }
    }
    finish();
  }, KILL_ESCALATE_MS);
}

/** Shut down every live PTY: drain the map, then graceful-kill-with-escalation
 *  via shutdownChildren. Used by the host's shutdown path. */
export function shutdownPtyChildren(
  onDone: () => void,
  schedule: (fn: () => void, ms: number) => void = setTimeout,
): void {
  // Block any further spawns (including one mid-preflight) from escaping the
  // snapshot below and getting orphaned when the host exits.
  shuttingDown = true;
  const entries = [...ptys.entries()];
  const children = entries.map(([, child]) => child);
  ptyLog.append("children-shutdown", { children: children.length });
  // Same identity-guard gap as killPty: the map is cleared below, so the
  // spawn-time onExit never logs these deaths. Log each child's exit (with
  // code) from here so a mass shutdown leaves a per-child trail (#88).
  for (const [ptyId, child] of entries) {
    child.onExit(({ exitCode }) => {
      ptyLog.append("exit", { ptyId, exitCode, killed: true });
    });
  }
  ptys.clear();
  outputBuffers.clear();
  pendingKills.clear();
  shutdownChildren(children, onDone, schedule);
}

export function activePtyCount(): number {
  return ptys.size;
}
