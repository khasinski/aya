// PTY host. One IPty per ptyId, all events forwarded to the renderer.
//
// We accept a literal `command` string from the renderer and wrap it in
// `$SHELL -l -c 'cd CWD && exec COMMAND'`. Using the user's login shell —
// not a hard-coded bash — lets PATH from their login profile (.zprofile /
// .zlogin, brew shellenv, /etc/paths) flow through; a bare bash wouldn't.
//
// CAVEAT: `-l -c` is a login but NON-interactive shell, so it does NOT source
// .zshrc / .bashrc — exactly where many users add ~/.local/bin, mise, asdf.
// Those dirs are recovered separately at startup by electron/shell-path.ts,
// which repairs process.env.PATH from a login+interactive shell before this
// host is spawned (the host inherits that env). Without that step, GUI-
// launched Aya would show "command not found: claude" for those installs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type * as PtyModule from "node-pty";
import type { PtyEvent, SpawnFailureReason, SpawnRequest } from "./types";
import { AYA_HOME, CONTROL_SOCKET_PATH } from "./paths";
import { userShell } from "./shell";

// Timeout for the shell `command -v` existence check during spawn preflight.
const COMMAND_CHECK_TIMEOUT_MS = 2500;
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
const outputBuffers = new Map<string, string[]>();

// Spawn/kill race guard: if killPty arrives before the corresponding
// spawnPty's IPC has finished (renderer remounted/closed quickly), the kill
// finds no IPty in the map and is a no-op. The pending spawn then runs and
// the resulting PTY is orphaned. We remember which ptyIds got an early kill
// and bail out of subsequent spawn for them.
const pendingKills = new Set<string>();
// Auto-evict pending-kill markers so stale ids don't linger forever (defense
// in depth — usually the spawn either runs within milliseconds or never).
const PENDING_KILL_TTL_MS = 5_000;

export interface PtyEventSink {
  isDestroyed(): boolean;
  sendPtyEvent(event: PtyEvent): void;
}

function appendToOutputBuffer(ptyId: string, chunk: string): void {
  let chunks = outputBuffers.get(ptyId);
  if (!chunks) {
    chunks = [];
    outputBuffers.set(ptyId, chunks);
  }
  chunks.push(chunk);
  let total = 0;
  for (const c of chunks) total += c.length;
  while (total > OUTPUT_BUFFER_MAX && chunks.length > 1) {
    const removed = chunks.shift();
    if (removed) total -= removed.length;
  }
}

export function __testAppendToOutputBuffer(ptyId: string, chunk: string): void {
  appendToOutputBuffer(ptyId, chunk);
}

export function __testClearOutputBuffers(): void {
  outputBuffers.clear();
}

export function getBufferedOutput(ptyId: string): string {
  const chunks = outputBuffers.get(ptyId);
  return chunks ? chunks.join("") : "";
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
  for (const [ptyId, chunks] of outputBuffers) {
    const cleaned = stripAnsi(chunks.join(""));
    const lower = cleaned.toLowerCase();
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

/** Build the shell argv for a given command + cwd. Uses the user's login +
 *  interactive shell so PATH/env/functions from their rc files (zsh, fish,
 *  bash, etc.) flow through. Many user launchers are shell functions or PATH
 *  edits in .zshrc/.bashrc, which login-only non-interactive shells skip. */
export function shellArgv(command: string, cwd: string): string[] {
  const cwdQuoted = shellQuote(cwd);
  // The user's command is embedded verbatim so $VARS / quoting / pipes work.
  // It must NOT be shell-quoted, or the shell would treat the whole thing
  // as one literal token.
  return [userShell(), "-l", "-i", "-c", `cd ${cwdQuoted} && exec ${command}`];
}

/** @deprecated Kept as an alias so existing tests / callers compile while
 *  in-flight branches converge. New code should call shellArgv. */
export const bashArgv = shellArgv;

/** Friendly error reporter — writes a red banner into the terminal and emits
 *  a synthetic exit so the host knows the spawn never happened. */
function reportSpawnFailure(
  sink: PtyEventSink,
  ptyId: string,
  reason: SpawnFailureReason,
  message: string,
): void {
  if (sink.isDestroyed()) return;
  const banner = `\r\n\x1b[1;31maya: \x1b[0m\x1b[31m${message}\x1b[0m\r\n\r\n`;
  sink.sendPtyEvent({ type: "spawn-failed", ptyId, reason, detail: message });
  sink.sendPtyEvent({ type: "data", ptyId, chunk: banner });
  sink.sendPtyEvent({ type: "exit", ptyId, exitCode: 127 });
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

function commandExists(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      userShell(),
      ["-l", "-i", "-c", `command -v -- ${binary} >/dev/null 2>&1`],
      { timeout: COMMAND_CHECK_TIMEOUT_MS, windowsHide: true },
      (err) => resolve(err === null),
    );
  });
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
  if (pendingKills.has(req.ptyId)) {
    // killPty arrived before this spawn (the renderer closed the tab between
    // mounting and the IPC round-trip). Drop the spawn so we don't orphan a
    // process the user already asked to discard.
    pendingKills.delete(req.ptyId);
    return;
  }
  if (ptys.has(req.ptyId)) {
    // Already running — this is a re-mount (Vite HMR or a React double-mount).
    // Don't spawn again; replay the buffered output so the freshly-created
    // xterm.js can repaint the existing scrollback. The PTY's own onData
    // continues to deliver new bytes to the renderer.
    const buffered = getBufferedOutput(req.ptyId);
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

  const binary = preflightBinary(req.command);
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

  ptys.set(req.ptyId, child);

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
    if (sink.isDestroyed()) return;
    sink.sendPtyEvent({ type: "exit", ptyId: req.ptyId, exitCode });
  });
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

export function killPty(ptyId: string): void {
  outputBuffers.delete(ptyId);
  const p = ptys.get(ptyId);
  if (!p) {
    // No PTY for this id yet — either it never existed, or the spawn IPC is
    // still in flight. Mark it so a late-arriving spawnPty bails out. The
    // TTL evicts the marker if nothing comes (cleaner than leaking ids).
    pendingKills.add(ptyId);
    setTimeout(() => pendingKills.delete(ptyId), PENDING_KILL_TTL_MS);
    return;
  }
  try {
    p.kill();
  } catch {
    // already gone
  }
  ptys.delete(ptyId);
}

export function killAll(): void {
  for (const [, p] of ptys) {
    try {
      p.kill();
    } catch {
      // ignore
    }
  }
  ptys.clear();
  outputBuffers.clear();
  pendingKills.clear();
}

export function activePtyCount(): number {
  return ptys.size;
}
