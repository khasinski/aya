// PTY host. One IPty per ptyId, all events forwarded to the renderer.
//
// We accept a literal `command` string from the renderer and wrap it in
// /bin/bash -lc 'cd CWD && exec COMMAND'. Bash handles variable expansion
// ($SHELL, $HOME, etc.) and PATH lookup. The renderer decides what command to
// send based on the active preset.

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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Build the bash argv for a given command + cwd. */
export function bashArgv(command: string, cwd: string): string[] {
  const cwdQuoted = shellQuote(cwd);
  // The user's command is embedded verbatim so $VARS / quoting / pipes work.
  // It must NOT be shell-quoted, or bash would treat the whole thing as one
  // literal token.
  return ["/bin/bash", "-lc", `cd ${cwdQuoted} && exec ${command}`];
}

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

  const argv = bashArgv(req.command, cwd);
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
