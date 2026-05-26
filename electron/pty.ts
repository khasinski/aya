// PTY host. One IPty per ptyId, all events forwarded to the renderer.
//
// We accept a literal `command` string from the renderer and wrap it in
// `$SHELL -lc 'cd CWD && exec COMMAND'`. Using the user's login shell —
// not a hard-coded bash — means PATH additions from zsh's .zshrc /
// .zprofile (mise, asdf, oh-my-zsh plugins, brew) work; otherwise users
// on zsh would see "command not found: claude" because bash doesn't read
// their rc files.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import type { WebContents } from "electron";
import type { SpawnRequest } from "./types";

const ptys = new Map<string, pty.IPty>();

// Per-PTY rolling buffer of recent output, used to repaint xterm.js when the
// renderer remounts (Vite HMR, React strict-mode double-mount, etc.). The PTY
// keeps running across these events but the new xterm.js instance has no
// scrollback — we replay the buffered bytes so the user sees the existing
// terminal state instead of an empty pane.
const OUTPUT_BUFFER_MAX = 200_000; // ~200kb of recent bytes per terminal
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

export function getBufferedOutput(ptyId: string): string {
  const chunks = outputBuffers.get(ptyId);
  return chunks ? chunks.join("") : "";
}

/** Strip ANSI escape sequences and control chars so search snippets are
 *  readable. Keeps newlines so line context survives. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[PX^_].*?\x1b\\/g, "")
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
    const start = Math.max(0, earliest.idx - 30);
    const end = Math.min(cleaned.length, earliest.idx + earliest.len + 50);
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
        if (more > 99) break;
      }
      if (more > 99) break;
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

/** Resolve the user's login shell, falling back to /bin/bash when SHELL
 *  isn't set (rare, but happens in some sandboxes). bash is the safe
 *  fallback because it definitely exists on every supported platform and
 *  accepts the -l + -c flags we need. */
function userShell(): string {
  return process.env.SHELL && process.env.SHELL.trim()
    ? process.env.SHELL
    : "/bin/bash";
}

/** Build the shell argv for a given command + cwd. Uses the user's login
 *  shell so PATH/env from their rc files (zsh, fish, etc.) flows through.
 *  zsh, bash, and fish all accept `-l -c "cmd"`; anything more exotic
 *  needs a custom preset command. */
export function shellArgv(command: string, cwd: string): string[] {
  const cwdQuoted = shellQuote(cwd);
  // The user's command is embedded verbatim so $VARS / quoting / pipes work.
  // It must NOT be shell-quoted, or the shell would treat the whole thing
  // as one literal token.
  return [userShell(), "-lc", `cd ${cwdQuoted} && exec ${command}`];
}

/** @deprecated Kept as an alias so existing tests / callers compile while
 *  in-flight branches converge. New code should call shellArgv. */
export const bashArgv = shellArgv;

/** Friendly error reporter — writes a red banner into the terminal and emits
 *  a synthetic exit so the host knows the spawn never happened. */
function reportSpawnFailure(
  wc: WebContents,
  ptyId: string,
  message: string,
): void {
  if (wc.isDestroyed()) return;
  const banner = `\r\n\x1b[1;31maya: \x1b[0m\x1b[31m${message}\x1b[0m\r\n\r\n`;
  wc.send("pty:event", { type: "data", ptyId, chunk: banner });
  wc.send("pty:event", { type: "exit", ptyId, exitCode: 127 });
}

function safeEnv(): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  if (!out.LANG) out.LANG = "en_US.UTF-8";
  if (!out.LC_ALL) out.LC_ALL = out.LANG;
  return out;
}

export function spawnPty(req: SpawnRequest, wc: WebContents): void {
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
    if (buffered && !wc.isDestroyed()) {
      wc.send("pty:event", {
        type: "data",
        ptyId: req.ptyId,
        chunk: buffered,
      });
    }
    return;
  }
  const cwd = path.resolve(req.cwd.replace(/^~/, os.homedir()));

  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      reportSpawnFailure(
        wc,
        req.ptyId,
        `not a directory: ${cwd}\nEdit the project to fix this, or close it.`,
      );
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      reportSpawnFailure(
        wc,
        req.ptyId,
        `directory does not exist: ${cwd}\nClose the project (top-bar ✕) to clean up.`,
      );
      return;
    }
    reportSpawnFailure(wc, req.ptyId, `cannot read ${cwd}: ${String(err)}`);
    return;
  }

  if (!req.command || !req.command.trim()) {
    reportSpawnFailure(
      wc,
      req.ptyId,
      `preset has no command — edit it in Settings.`,
    );
    return;
  }

  const argv = shellArgv(req.command, cwd);
  const file = argv[0];
  const args = argv.slice(1);

  let child: pty.IPty;
  try {
    child = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: Math.max(req.cols, 4),
      rows: Math.max(req.rows, 2),
      cwd,
      env: safeEnv(),
    });
  } catch (err) {
    reportSpawnFailure(
      wc,
      req.ptyId,
      `failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  ptys.set(req.ptyId, child);

  child.onData((chunk) => {
    appendToOutputBuffer(req.ptyId, chunk);
    if (wc.isDestroyed()) return;
    wc.send("pty:event", { type: "data", ptyId: req.ptyId, chunk });
  });

  child.onExit(({ exitCode }) => {
    ptys.delete(req.ptyId);
    outputBuffers.delete(req.ptyId);
    if (wc.isDestroyed()) return;
    wc.send("pty:event", { type: "exit", ptyId: req.ptyId, exitCode });
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
    p.resize(Math.max(cols, 4), Math.max(rows, 2));
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
