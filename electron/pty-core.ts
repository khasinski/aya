// PTY host. One IPty per ptyId, all events forwarded to the renderer.
//
// We accept a literal `command` string from the renderer and wrap it in
// `$SHELL -l -i -c 'cd CWD && exec COMMAND'`. Using the user's login +
// interactive shell - not a hard-coded bash - lets PATH, functions, aliases,
// and env from their normal terminal startup files flow through.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as PtyModule from "node-pty";
import type { PtyEvent, SpawnFailureReason, SpawnRequest } from "./types";
import {
  extractAyaOsc,
  parseAyaOscSession,
  parseAyaOscStatus,
} from "./osc-extractor";
import {
  closeAllVtPanes,
  closeVtPane,
  openVtPane,
  resizeVtPane,
  vtPaneAltScreen,
  writeVtPane,
} from "./vt-mirror";
import type { PaneLaunch } from "./launch-mode";
import type { PaneSize } from "./pane-render";
import { COMMAND_NOT_FOUND_EXIT_CODE, MIN_PTY_COLS, MIN_PTY_ROWS } from "./pty-core-constants";
import { ptyLog } from "./pty-log";

export type PreparedSpawn =
  | { failure: { reason: SpawnFailureReason; message: string } }
  | { argv: string[]; env: Record<string, string>; command: string; launch: PaneLaunch; ownSessionId: string | null; spawnedAt: number };
export interface SpawnServices {
  prepare(req: SpawnRequest, cwd: string, signal: AbortSignal): Promise<PreparedSpawn>;
  opened?(req: SpawnRequest, pid: number, prepared: Exclude<PreparedSpawn, { failure: unknown }>, sink: PtyEventSink): () => void;
  openMirror?: typeof openVtPane;
  replay?(req: SpawnRequest, pid: number, spawnedAt: number, sink: PtyEventSink): Promise<void> | void;
}
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
const launches = new Map<string, PaneLaunch>();
const spawnTimes = new Map<string, number>();

const vtStatusEvent = (ptyId: string, waiting: boolean, dialog: string | undefined): PtyEvent =>
  dialog ? { type: "vt-status", ptyId, waiting, dialog } : { type: "vt-status", ptyId, waiting };

// Per-PTY rolling buffer of recent output, used to repaint xterm.js when the
// renderer remounts (Vite HMR, React strict-mode double-mount, etc.). The PTY
// keeps running across these events but the new xterm.js instance has no
// scrollback - we replay the buffered bytes so the user sees the existing
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

// Per-PTY held-back partial OSC 9001 sequence, when a chunk boundary lands
// mid-sequence (see osc-extractor.ts). Cleared alongside outputBuffers on
// exit/kill/shutdown so nothing leaks across a respawn under the same id.
const oscCarryBuffers = new Map<string, string>();

// Spawn/kill race guard: if killPty arrives before the corresponding
// spawnPty's IPC has finished (renderer remounted/closed quickly), the kill
// finds no IPty in the map and is a no-op. The pending spawn then runs and
// the resulting PTY is orphaned. We remember which ptyIds got an early kill
// and bail out of subsequent spawn for them.
const pendingKills = new Set<string>();
// Auto-evict pending-kill markers so stale ids don't linger forever (defense
// in depth - usually the spawn either runs within milliseconds or never).
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
// so a racing call bails instead of starting a second process. A kill that
// lands meanwhile cancels THAT spawn: the flag lives on its own entry, so no
// other spawn call can consume it and no timer can expire it. `done` settles
// when the spawn does, so a restart that meets a cancelled flight can wait it
// out instead of being dropped (see spawnPty).
interface SpawnFlight {
  abort: AbortController;
  cancelled: boolean;
  done: Promise<void>;
}
const spawning = new Map<string, SpawnFlight>();

function newFlight(): [SpawnFlight, () => void] {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  return [{ abort: new AbortController(), cancelled: false, done }, settle];
}
// Waiters for input parked on an in-flight spawn. Buffering is not delivery: a
// failed spawn discards the queue, so each waiter gets the real outcome.
const spawnWaiters = new Map<string, ((delivered: boolean) => void)[]>();

/** Settle the parked waiters; `delivered` = the queue reached a live PTY. */
function settleSpawnWaiters(ptyId: string, delivered: boolean): void {
  const waiters = spawnWaiters.get(ptyId);
  if (!waiters) return;
  spawnWaiters.delete(ptyId);
  for (const resolve of waiters) resolve(delivered);
}
// Keystrokes that arrived while a spawn was still in flight. A real tty buffers
// what you type before the shell has read it; dropping it here instead meant a
// command typed into a pane that looked ready vanished with no echo and no
// error. Held only across the spawn window: once the PTY registers, these are
// written in order and the map entry is gone (see spawnPty's flush + finally).
const pendingWrites = new Map<string, string[]>();
// Bound per id, so a spawn that never completes (or a paste into a pane whose
// command hangs in preflight) cannot grow the host's memory without limit.
// Well above any realistic burst of typing; a chunk past it is refused whole.
export const PENDING_WRITE_MAX_BYTES = 64 * 1024;
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

/** Input held for an in-flight spawn: [chunks, bytes]. Empty once any spawn settles, so a test looks while
 *  the spawn is still in flight. */
export function __testPendingWrites(ptyId: string): [number, number] {
  const queued = pendingWrites.get(ptyId) ?? [];
  return [queued.length, queued.reduce((n, s) => n + Buffer.byteLength(s), 0)];
}

export function getBufferedOutput(ptyId: string): string {
  const buffer = outputBuffers.get(ptyId);
  return buffer ? buffer.chunks.join("") : "";
}

/** Strip ANSI escape sequences and control chars so search snippets are
 *  readable. Keeps newlines so line context survives. Exported for unit tests. */
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

/** Case-insensitive AND-search over every live PTY buffer: each whitespace token must appear; the snippet
 *  surrounds the earliest-occurring token. */
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

/** Friendly error reporter - writes a red banner into the terminal and emits
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

const PANE_TERM = "xterm-256color";
export const SPAWN_LOG_COMMAND_MAX_CHARS = 4096;

export async function spawnPty(req: SpawnRequest, sink: PtyEventSink, services: SpawnServices): Promise<void> {
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
    // Already running - this is a re-mount (Vite HMR or a React double-mount).
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
    await services.replay?.(req, ptys.get(req.ptyId)!.pid, spawnTimes.get(req.ptyId) ?? Date.now(), sink);
    return;
  }
  const inFlight = spawning.get(req.ptyId);
  if (inFlight && !inFlight.cancelled) {
    // A spawn for this id is already in flight (a concurrent re-mount got here
    // first, before it could register its PTY). Bail BEFORE the attachOnly
    // branch: the in-flight spawn owns the session and will stream to the
    // renderer, so emitting no-session here would falsely strand the tab as
    // stopped. (Checked before attachOnly so the host is robust regardless of
    // the renderer's confirmed-output gating.)
    ptyLog.append("spawn-dropped-in-flight", { ptyId: req.ptyId });
    return;
  }
  if (inFlight) {
    // The flight was killed (a restart: kill, then spawn the same id) but is
    // still in its preflight. Dropping this spawn would leave the tab with no
    // process and no event. Take the id over now, so a later kill cancels THIS
    // spawn and a re-mount meanwhile is dropped, wait for the old flight to
    // return, then start over from the top.
    await takeOverCancelledFlight(req, sink, inFlight, services);
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

  // Mark this id in-flight across the async preflight + spawn so a concurrent
  // call bails at the guard above. (The bail itself lives before the attachOnly
  // branch; here we only claim the marker, synchronously before the first await
  // so no racing call can interleave before it is set.)
  const [flight, settleFlight] = newFlight();
  spawning.set(req.ptyId, flight);
  const cancelled = (): boolean => {
    if (flight.cancelled) ptyLog.append("spawn-cancelled", { ptyId: req.ptyId });
    return flight.cancelled;
  };
  try {
    const prepared = await services.prepare(req, cwd, flight.abort.signal);
    if (cancelled() || shuttingDown) return;
    if ("failure" in prepared) {
      reportSpawnFailure(sink, req.ptyId, prepared.failure.reason, prepared.failure.message);
      return;
    }
    const { command, env, launch, ownSessionId } = prepared;
    const [file, ...args] = prepared.argv;

    let child: PtyModule.IPty;
    try {
      child = loadNodePty().spawn(file, args, {
        name: PANE_TERM,
        cols: Math.max(req.cols, MIN_PTY_COLS),
        rows: Math.max(req.rows, MIN_PTY_ROWS),
        cwd,
        env,
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
    launches.set(req.ptyId, launch);
    spawnTimes.set(req.ptyId, prepared.spawnedAt);
    // Replay anything typed during the spawn window, in order, before the pane
    // takes live input. Writes arriving after this point find the PTY through
    // `ptys` on the normal path, so there is no gap between flush and cleanup.
    const queued = pendingWrites.get(req.ptyId);
    if (queued?.length) {
      pendingWrites.delete(req.ptyId);
      ptyLog.append("pending-write-flush", {
        ptyId: req.ptyId,
        chunks: queued.length,
      });
      // PTY input is the user's own shell input; no code-injection boundary.
      for (const chunk of queued) child.write(chunk); // lgtm[js/code-injection]
    }
    // Mirror of the pane's screen, used to tell what it SHOWS (see vt-state.ts).
    // Fires on both edges, so a prompt appearing AND being answered both
    // reach the renderer.
    (services.openMirror ?? openVtPane)(
      req.ptyId,
      req.cols,
      req.rows,
      (waiting, dialog) => {
        if (sink.isDestroyed()) return;
        sink.sendPtyEvent(vtStatusEvent(req.ptyId, waiting, dialog));
      },
      req.agent,
      prepared.argv[4]?.includes("env -u EDITOR -u VISUAL $SHELL") ?? false,
    );
    // The command is logged verbatim: it is the single most diagnostic field
    // (e.g. did this respawn carry --continue?), and it is already stored in
    // plaintext in ~/.aya/presets.json - the log adds no new exposure.
    ptyLog.append("spawn", {
      ptyId: req.ptyId,
      childPid: child.pid,
      projectSlug: req.projectSlug,
      presetId: req.presetId,
      cwd,
      command: command.slice(0, SPAWN_LOG_COMMAND_MAX_CHARS),
    });

    child.onData((chunk) => {
      // Strip Aya's OSC 9001 vocabulary (integrations.md) before anything
      // downstream sees this chunk: the agent's visible output, the replay
      // buffer, and search must never contain raw escape-sequence noise, and
      // must reflect the exact bytes xterm.js renders.
      const carry = oscCarryBuffers.get(req.ptyId) ?? "";
      const extracted = extractAyaOsc(chunk, carry);
      if (extracted.carry) {
        oscCarryBuffers.set(req.ptyId, extracted.carry);
      } else if (carry) {
        oscCarryBuffers.delete(req.ptyId);
      }
      appendToOutputBuffer(req.ptyId, extracted.cleaned);
      // Same bytes the renderer's xterm will draw, so the mirror matches what
      // the user sees.
      writeVtPane(req.ptyId, extracted.cleaned);
      if (sink.isDestroyed()) return;
      sink.sendPtyEvent({ type: "data", ptyId: req.ptyId, chunk: extracted.cleaned });
      for (const event of extracted.events) {
        const status = parseAyaOscStatus(event);
        if (status) {
          sink.sendPtyEvent({
            type: "osc-status",
            ptyId: req.ptyId,
            level: status.level,
            text: status.text,
            updatedAt: Date.now(),
          });
          continue;
        }
        const sessionId = parseAyaOscSession(event);
        if (sessionId) {
          sink.sendPtyEvent({ type: "osc-session", ptyId: req.ptyId, sessionId });
        }
      }
    });

    // Known before the CLI writes anything, so a restart before its first message resumes it.
    if (ownSessionId) sink.sendPtyEvent({ type: "osc-session", ptyId: req.ptyId, sessionId: ownSessionId });
    const stopSessionWatch = services.opened?.(req, child.pid, prepared, sink) ?? (() => {});

    child.onExit(({ exitCode, signal }) => {
      stopSessionWatch();
      if (ptys.get(req.ptyId) !== child) {
        return;
      }
      ptys.delete(req.ptyId);
      launches.delete(req.ptyId);
      spawnTimes.delete(req.ptyId);
      outputBuffers.delete(req.ptyId);
      oscCarryBuffers.delete(req.ptyId);
      closeVtPane(req.ptyId);
      // Record the signal on this NON-host-initiated death (#83): when every
      // console dies at once with the host alive, `signal: 9` (SIGKILL) points
      // at an OS jetsam/memory-pressure kill, distinct from a graceful exit or
      // a host-initiated kill. Absence of any exit line at all, meanwhile,
      // means the renderer reloaded and cold-respawned rather than dying.
      ptyLog.append("exit", { ptyId: req.ptyId, exitCode, signal });
      if (sink.isDestroyed()) return;
      sink.sendPtyEvent({ type: "exit", ptyId: req.ptyId, exitCode });
    });
  } finally {
    // A restart may have taken the id over while this (cancelled) spawn was in
    // preflight: the entry and any input queued since belong to it then.
    if (spawning.get(req.ptyId) === flight) {
      spawning.delete(req.ptyId);
      // Covers every early return above (preflight failure, spawn error,
      // shutdown): the spawn window is over, so nothing may keep holding input
      // for it. On the success path the flush already emptied this.
      endSpawnWindow(req.ptyId);
    }
    settleFlight();
  }
}

/** Drop input held for a spawn window that is over; a live PTY means the flush
 *  ran, anything else discarded the queue. */
function endSpawnWindow(ptyId: string): void {
  pendingWrites.delete(ptyId);
  settleSpawnWaiters(ptyId, ptys.has(ptyId));
}

async function takeOverCancelledFlight(
  req: SpawnRequest,
  sink: PtyEventSink,
  prior: SpawnFlight,
  services: SpawnServices,
): Promise<void> {
  const [flight, settleFlight] = newFlight();
  spawning.set(req.ptyId, flight);
  ptyLog.append("spawn-waits-cancelled", { ptyId: req.ptyId });
  try {
    await prior.done;
  } finally {
    if (spawning.get(req.ptyId) === flight) spawning.delete(req.ptyId);
    settleFlight();
  }
  if (flight.cancelled) {
    // Killed again while waiting (the tab closed after all): start nothing.
    ptyLog.append("spawn-cancelled", { ptyId: req.ptyId });
    if (!spawning.has(req.ptyId)) endSpawnWindow(req.ptyId);
    return;
  }
  // Synchronous up to its first await, so nothing interleaves between the
  // delete above and it claiming the id again; input typed while this waited
  // stays queued for it.
  await spawnPty(req, sink, services);
  // An early return before its claim (attach-only, bad cwd) leaves no window
  // to flush the queue; unless a newer spawn owns the id by now, end it here.
  if (!spawning.has(req.ptyId)) endSpawnWindow(req.ptyId);
}

/** True while a spawn for this id is in its preflight and not cancelled: the
 *  pane has no PTY yet, but it is coming. */
export function isPtyStarting(ptyId: string): boolean {
  const flight = spawning.get(ptyId);
  return flight !== undefined && !flight.cancelled;
}

export function getPtyLaunch(ptyId: string): PaneLaunch | null {
  return launches.get(ptyId) ?? null;
}

/** The PTY's current size and whether its screen is the alternate one; null
 *  once the pane is gone. */
export function getPtySize(ptyId: string): PaneSize | null {
  const p = ptys.get(ptyId);
  return p ? { cols: p.cols, rows: p.rows, alt: vtPaneAltScreen(ptyId) } : null;
}

export function getPtyPid(ptyId: string): number | null {
  return ptys.get(ptyId)?.pid ?? null;
}

/** Write to a PTY; false means it went NOWHERE (dead id, queue at cap, failed
 *  spawn). Async but holds NO `await`, so `p.write` keeps its place in order. */
export async function writePty(ptyId: string, data: string): Promise<boolean> {
  const p = ptys.get(ptyId);
  if (!p) {
    // No PTY yet, but one is on its way: hold the input rather than discard it.
    // Anything else (an exited or unknown id) still drops, as before.
    if (spawning.has(ptyId)) {
      if (!bufferPendingWrite(ptyId, data)) return false;
      // Queued is not delivered: answer only once the spawn settles.
      return new Promise<boolean>((resolve) => {
        const waiters = spawnWaiters.get(ptyId) ?? [];
        waiters.push(resolve);
        spawnWaiters.set(ptyId, waiters);
      });
    }
    return false;
  }
  // Writing to the user's own PTY is the whole point of a terminal: the
  // "user-provided value" is their own keystrokes going to their own shell, so
  // there is no trust boundary to cross. Not exploitable code injection.
  p.write(data); // lgtm[js/code-injection]
  return true;
}

/** Queue input for an in-flight spawn, capped at PENDING_WRITE_MAX_BYTES. False when the chunk
 *  was not queued WHOLE: a cut paste would leave the pane mid-paste. */
function bufferPendingWrite(ptyId: string, data: string): boolean {
  const queued = pendingWrites.get(ptyId) ?? [];
  const used = queued.reduce((n, s) => n + Buffer.byteLength(s), 0);
  const bytes = Buffer.byteLength(data);
  if (bytes > PENDING_WRITE_MAX_BYTES - used) {
    ptyLog.append("pending-write-dropped", { ptyId, bytes });
    return false;
  }
  queued.push(data);
  pendingWrites.set(ptyId, queued);
  return true;
}

export function resizePty(ptyId: string, cols: number, rows: number): void {
  const p = ptys.get(ptyId);
  if (!p) return;
  resizeVtPane(ptyId, cols, rows);
  try {
    p.resize(Math.max(cols, MIN_PTY_COLS), Math.max(rows, MIN_PTY_ROWS));
  } catch {
    // ignore - pty may have just exited
  }
}

/** Kill a PTY child, escalating to SIGKILL (`claude --chrome` ignores TERM and
 *  would orphan). `schedule` is injectable so tests can drive that step. */
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
      // already exited - nothing to force-kill
    }
  }, KILL_ESCALATE_MS);
}

export function killPty(ptyId: string): void {
  outputBuffers.delete(ptyId);
  oscCarryBuffers.delete(ptyId);
  closeVtPane(ptyId);
  const p = ptys.get(ptyId);
  ptyLog.append("kill", { ptyId, live: !!p });
  if (!p) {
    // No PTY for this id yet. A spawn under way is cancelled on its own entry
    // (no marker: ids are reused, and a reopened tab must start). One whose
    // IPC has not arrived yet bails on the marker, which a TTL evicts if
    // nothing comes (cleaner than leaking ids).
    const flight = spawning.get(ptyId);
    if (flight) {
      flight.cancelled = true;
      flight.abort.abort();
      // What was typed into the killed spawn goes nowhere, even if a restart
      // takes the id over before this spawn returns.
      endSpawnWindow(ptyId);
      return;
    }
    pendingKills.add(ptyId);
    setTimeout(() => pendingKills.delete(ptyId), PENDING_KILL_TTL_MS);
    return;
  }
  // Remove from the map first (a re-mount/respawn should not attach to a dying
  // PTY), then terminate with SIGKILL escalation so a signal-ignoring child
  // can't survive and get orphaned.
  ptys.delete(ptyId);
  launches.delete(ptyId);
  spawnTimes.delete(ptyId);
  // The spawn-time onExit skips its "exit" append once the map entry is gone
  // (its identity guard exists so a respawn under the same id is not wrongly
  // torn down) - so log the killed child's actual exit here, or the forensic
  // trail shows a kill with no evidence the child ever died (#88).
  p.onExit(({ exitCode }) => {
    ptyLog.append("exit", { ptyId, exitCode, killed: true });
  });
  terminatePtyChild(p);
}

/** Graceful signal to each child, `onDone` exactly once when the last exits, SIGKILL for survivors at the
 *  KILL_ESCALATE_MS deadline. Split out (injectable `schedule`) so the ladder is testable with fake children. */
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
      // Can't observe this child's exit - let the deadline cover it.
    }
    try {
      p.kill(); // graceful first; a well-behaved child exits and triggers onExit
    } catch {
      settleOne(); // already gone - counts as settled
    }
  }

  schedule(() => {
    for (const p of children) {
      try {
        p.kill("SIGKILL");
      } catch {
        // already exited - nothing to force-kill
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
  for (const flight of spawning.values()) { flight.cancelled = true; flight.abort.abort(); }
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
  spawnTimes.clear();
  launches.clear();
  outputBuffers.clear();
  oscCarryBuffers.clear();
  closeAllVtPanes();
  pendingKills.clear();
  shutdownChildren(children, onDone, schedule);
}

export function activePtyCount(): number {
  return ptys.size;
}
