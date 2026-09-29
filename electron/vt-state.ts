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
import { MIN_PTY_COLS, MIN_PTY_ROWS } from "./constants";
import { evaluateScreen, TAIL_REGION_LINES } from "./agent-screen-rules";
import { HOLD_NOT_RUNNING, HOLD_STARTING } from "./pane-holds";
import type { AgentKind } from "./presets";

// Only the visible screen matters for "what is on screen right now", and
// scrollback would grow a buffer per pane in the host process for no gain.
const VT_SCROLLBACK_LINES = 0;
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
  /** A plain shell: typed text would run as a command. */
  shell: boolean;
  lastWaiting: boolean;
  /** The agent's composer has been on screen once: it has finished starting. */
  composerSeen: boolean;
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
  shell = false,
): void {
  panes.set(ptyId, {
    terminal: new Terminal({
      cols: Math.max(cols, MIN_PTY_COLS),
      rows: Math.max(rows, MIN_PTY_ROWS),
      scrollback: VT_SCROLLBACK_LINES,
      allowProposedApi: true,
    }),
    agent,
    shell,
    lastWaiting: false,
    composerSeen: false,
    timer: null,
    onChange,
  });
}

export function resizeVtPane(ptyId: string, cols: number, rows: number): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  try {
    pane.terminal.resize(Math.max(cols, MIN_PTY_COLS), Math.max(rows, MIN_PTY_ROWS));
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
  // Only until first seen: the search walks the scrollback when none is there.
  if (!pane.composerSeen && COMPOSER_AGENTS.has(pane.agent) && composerState(pane.terminal) !== "absent") {
    pane.composerSeen = true;
  }
  const verdict = evaluateScreen(screenRows(pane.terminal), pane.agent);
  // No opinion: say nothing rather than assert a state change, so a weaker
  // signal (src/bell.ts) keeps whatever it had.
  if (verdict === null) return;
  const waiting = verdict === "waiting";
  if (waiting === pane.lastWaiting) return;
  pane.lastWaiting = waiting;
  pane.onChange(waiting);
}

/** Whether the pane's mirror is on the alt screen; undefined for no mirror. */
export function vtPaneAltScreen(ptyId: string): boolean | undefined {
  const pane = panes.get(ptyId);
  return pane && pane.terminal.buffer.active.type === "alternate";
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

/** The last `TAIL_REGION_LINES` non-empty rows as one string. Kept for tests and
 *  for any future screen-derived signal. */
export function screenTail(
  terminal: Terminal,
  maxLines: number = TAIL_REGION_LINES,
): string {
  return screenRows(terminal)
    .filter((row) => row.trim())
    .slice(-maxLines)
    .join("\n");
}

/** Whether the pane's screen currently shows an approval prompt. No production
 *  caller - this is the tests' observation window onto evaluateScreen, which the
 *  live path reaches through scanPane. */
export function screenShowsApproval(
  terminal: Terminal,
  agent?: AgentKind,
): boolean {
  return evaluateScreen(screenRows(terminal), agent) === "waiting";
}

// The composer prompt: Claude and Grok draw "❯", Codex "›", Grok inside a box.
const COMPOSER_RE = /^\s*(?:│\s*)?[❯›]\s/;
// A numbered menu row ("❯ 1. Alpha", "› 2) Beta") uses the composer's chevron;
// it is a choice waiting for an answer, not text typed by the user.
const NUMBERED_OPTION_RE = /^\s*(?:│\s*)?[❯›]\s*\d+[.)]\s/;
const FRAME_RE = /[─│╭╮╰╯\s]/g;

type ComposerState = "draft" | "numbered-choice" | "empty" | "absent";

// Agents whose composer COMPOSER_RE knows; others are never "starting up".
const COMPOSER_AGENTS: ReadonlySet<AgentKind | undefined> = new Set(["claude", "codex", "grok"]);

/** Classify the lowest prompt row. Dim placeholders and box frame characters
 *  are not typed text. */
function composerState(terminal: Terminal): ComposerState {
  const buffer = terminal.buffer.active;
  for (let y = buffer.length - 1; y >= 0; y -= 1) {
    const line = buffer.getLine(y);
    const text = line?.translateToString(true) ?? "";
    const prompt = text.match(COMPOSER_RE);
    if (!line || !prompt) continue;
    if (NUMBERED_OPTION_RE.test(text)) return "numbered-choice";
    let typed = "";
    for (let x = prompt[0].length; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (cell && !cell.isDim()) typed += cell.getChars();
    }
    return typed.replace(FRAME_RE, "") !== "" ? "draft" : "empty";
  }
  return "absent";
}

/** Why a message must not be typed into this pane now, or null. */
export function paneHold(ptyId: string): string | null {
  const pane = panes.get(ptyId);
  // Every live PTY has a mirror; none means it exited or never started.
  if (!pane) return HOLD_NOT_RUNNING;
  if (pane.shell) return "runs a shell";
  if (evaluateScreen(screenRows(pane.terminal), pane.agent) === "waiting") return "shows an approval prompt";
  const composer = composerState(pane.terminal);
  if (composer !== "absent") pane.composerSeen = true;
  // Measured: a message typed before the composer is drawn goes nowhere.
  if (!pane.composerSeen && COMPOSER_AGENTS.has(pane.agent)) return HOLD_STARTING;
  if (composer === "numbered-choice") return "shows a numbered choice";
  if (composer === "draft") return "has text the user is typing";
  return null;
}

export function __testVtPane(ptyId: string): VtPane | undefined {
  return panes.get(ptyId);
}

/** Force a scan without waiting for the debounce. Tests only — production
 *  always goes through writeVtPane's timer. */
export function __testScanVtPane(ptyId: string): void {
  scanPane(ptyId);
}
