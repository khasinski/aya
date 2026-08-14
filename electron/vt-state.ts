// Server-side terminal screen state, so Aya can tell what a pane actually
// SHOWS rather than guessing from the bytes that flew past.
//
// src/bell.ts matches approval patterns against the raw chunk stream. That
// cannot distinguish "the agent is asking for approval right now" from "the
// agent printed that text a while ago and has since repainted over it" — a TUI
// redraws constantly, so the prompt keeps reappearing in the byte stream long
// after it left the screen. Feeding the same bytes through a real VT parser
// gives the current screen, which is the thing the user is actually looking at.
//
// This runs in the pty host (which already owns the byte stream), so it works
// whether or not any window is open, and it costs one extra VT parse per pane.

import { Terminal } from "@xterm/headless";
import { evaluateScreen } from "./agent-screen-rules";
import type { AgentKind } from "./presets";

// Only the visible screen matters for "what is on screen right now", and
// scrollback would grow a buffer per pane in the host process for no gain.
const VT_SCROLLBACK_LINES = 0;
// How many non-empty screen lines from the bottom the detector considers.
// An approval prompt is always near the cursor; scanning the whole screen
// would match a prompt the agent has already scrolled past within one screen.
const SCAN_TAIL_LINES = 12;
// The screen is scanned at most this often per pane. Writes are applied
// immediately; only the (comparatively expensive) scan is rate-limited, so a
// firehose of output costs one scan per interval rather than one per chunk.
const SCAN_INTERVAL_MS = 250;

export interface VtPane {
  terminal: Terminal;
  /** Which agent CLI runs here, so its own screen rules apply. Undefined for
   *  a plain shell or an agent we have no rules for — those fall back to the
   *  generic rule set. */
  agent: AgentKind | undefined;
  lastWaiting: boolean;
  /** Pending trailing scan, so a pane that goes quiet right after painting a
   *  prompt still gets scanned once more. */
  timer: ReturnType<typeof setTimeout> | null;
  onChange: (waiting: boolean) => void;
}

const panes = new Map<string, VtPane>();

export function openVtPane(
  ptyId: string,
  cols: number,
  rows: number,
  onChange: (waiting: boolean) => void,
  agent?: AgentKind,
): void {
  panes.set(ptyId, {
    terminal: new Terminal({
      cols: Math.max(cols, 1),
      rows: Math.max(rows, 1),
      scrollback: VT_SCROLLBACK_LINES,
      allowProposedApi: true,
    }),
    agent,
    lastWaiting: false,
    timer: null,
    onChange,
  });
}

export function resizeVtPane(ptyId: string, cols: number, rows: number): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  try {
    pane.terminal.resize(Math.max(cols, 1), Math.max(rows, 1));
  } catch {
    // A resize can race the pane closing; the next write just lands on the
    // old geometry, which only affects wrapping in the detector's input.
  }
}

export function closeVtPane(ptyId: string): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  panes.delete(ptyId);
  if (pane.timer) clearTimeout(pane.timer);
  try {
    pane.terminal.dispose();
  } catch {
    // Disposal is best-effort — the pane is already unreachable either way.
  }
}

export function closeAllVtPanes(): void {
  for (const ptyId of [...panes.keys()]) closeVtPane(ptyId);
}

/** Feed a chunk to the mirror and schedule a scan. The scan is deferred rather
 *  than run inline because xterm parses writes asynchronously — reading the
 *  buffer immediately would see the state BEFORE this chunk. The timer also
 *  debounces: a burst of output produces one scan, and a pane that then goes
 *  silent still gets that final scan. */
export function writeVtPane(ptyId: string, chunk: string): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  pane.terminal.write(chunk);
  if (pane.timer) return;
  pane.timer = setTimeout(() => {
    pane.timer = null;
    scanPane(ptyId);
  }, SCAN_INTERVAL_MS);
  // Never hold the host process open just to run a screen scan.
  pane.timer.unref?.();
}

function scanPane(ptyId: string): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  const verdict = evaluateScreen(screenRows(pane.terminal), pane.agent);
  // No opinion: say nothing rather than assert a state change, so a weaker
  // signal (src/bell.ts) keeps whatever it had.
  if (verdict === null) return;
  const waiting = verdict === "waiting";
  if (waiting === pane.lastWaiting) return;
  pane.lastWaiting = waiting;
  pane.onChange(waiting);
}

/** Every rendered screen row, top to bottom, positions preserved. Rules anchor
 *  to regions (the last line, the tail, the whole screen), so blank rows are
 *  kept here and filtered per-region rather than collapsed away up front. */
export function screenRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return rows;
}

/** The last `SCAN_TAIL_LINES` non-empty rows as one string. Kept for tests and
 *  for any future screen-derived signal. */
export function screenTail(
  terminal: Terminal,
  maxLines: number = SCAN_TAIL_LINES,
): string {
  return screenRows(terminal)
    .filter((row) => row.trim())
    .slice(-maxLines)
    .join("\n");
}

export function screenShowsApproval(
  terminal: Terminal,
  agent?: AgentKind,
): boolean {
  return evaluateScreen(screenRows(terminal), agent) === "waiting";
}

export function __testVtPane(ptyId: string): VtPane | undefined {
  return panes.get(ptyId);
}

/** Force a scan without waiting for the debounce. Tests only — production
 *  always goes through writeVtPane's timer. */
export function __testScanVtPane(ptyId: string): void {
  scanPane(ptyId);
}
