// A VT parser in the pty host gives the screen the user sees now, with no window open; a pattern over raw
// chunks cannot (an old prompt the CLI has since repainted over still matches).

import { Terminal } from "@xterm/headless";
import { MIN_PTY_COLS, MIN_PTY_ROWS } from "./constants";
import { asksToRunAya, evaluateScreen, screenIsBusy, screenShowsUsageLimit } from "./agent-screen-rules";
import { HOLD_APPROVAL, HOLD_APPROVE_AYA, HOLD_BUSY, HOLD_CHOICE, HOLD_DRAFT, HOLD_NOT_RUNNING, HOLD_SHELL, HOLD_STARTING, HOLD_USAGE_LIMIT } from "./pane-holds";
import type { AgentKind } from "./presets";

// Only the visible screen matters for "what is on screen right now", and
// scrollback would grow a buffer per pane in the host process for no gain.
const VT_SCROLLBACK_LINES = 0;
// The screen is scanned at most this often per pane. Writes are applied
// immediately; only the (comparatively expensive) scan is rate-limited, so a
// firehose of output costs one scan per interval rather than one per chunk.
const SCAN_INTERVAL_MS = 250;
/** A pane with no composer rule (kilo, pi, a custom preset) is starting until it has drawn and its screen stood still
 *  this long, once; at most SCREEN_SETTLE_MAX_MS after the spawn, so a clock, or a pane that never draws, takes messages. */
export const SCREEN_SETTLE_MS = 1_000;
export const SCREEN_SETTLE_MAX_MS = 8_000;

export interface VtPane {
  terminal: Terminal;
  /** Whose screen rules apply; undefined (a shell, an unknown CLI) takes the generic ones. */
  agent: AgentKind | undefined;
  /** A plain shell: typed text would run as a command. */
  shell: boolean;
  lastWaiting: boolean;
  /** The agent has finished starting: its composer was on screen once, or (no composer rule) its screen settled. */
  composerSeen: boolean;
  /** When the mirror opened and when the pane last wrote (null: nothing yet): a pane with no composer rule is up once quiet. */
  openedAt: number;
  lastOutputAt: number | null;
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
    openedAt: Date.now(),
    lastOutputAt: null,
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
    // Disposal is best-effort - the pane is already unreachable either way.
  }
}

export function closeAllVtPanes(): void {
  for (const ptyId of [...panes.keys()]) closeVtPane(ptyId);
}

/** Deferred scan: xterm parses writes asynchronously, so an inline read would see the screen before this chunk.
 *  A burst gets one scan, and a pane that then goes silent still gets that last one. */
export function writeVtPane(ptyId: string, chunk: string): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  pane.terminal.write(chunk);
  pane.lastOutputAt = Date.now();
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
  const rows = screenRows(pane.terminal);
  // A numbered choice is a question for the user as much as an approval dialog (paneHold holds messages for it too).
  const screen = evaluateScreen(rows, pane.agent);
  const composer = composerState(pane.terminal);
  const verdict = screen !== null && composer === "numbered-choice" ? "waiting" : screen;
  // Only until first seen: the search walks the scrollback when none is there. A dialog's
  // selected row reads as a draft, so a waiting screen is never the composer.
  if (!pane.composerSeen && verdict !== "waiting" && COMPOSER_AGENTS.has(pane.agent) && firstComposer(pane, composer, rows)) {
    pane.composerSeen = true;
  }
  // No opinion (an empty screen): say nothing rather than assert a state change.
  if (verdict === null) return;
  const waiting = verdict === "waiting";
  if (waiting === pane.lastWaiting) return;
  pane.lastWaiting = waiting;
  pane.onChange(waiting);
}

/** Whether the pane's screen last showed a dialog: its edges are one-shot, so a window attaching later asks. */
export function vtPaneWaiting(ptyId: string): boolean {
  return panes.get(ptyId)?.lastWaiting ?? false;
}

/** Whether the pane's mirror is on the alt screen; undefined for no mirror. */
export function vtPaneAltScreen(ptyId: string): boolean | undefined {
  const pane = panes.get(ptyId);
  return pane && pane.terminal.buffer.active.type === "alternate";
}

/** Blank rows are kept: each rule region filters them. */
export function screenRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return rows;
}

/** Tests' window onto evaluateScreen, which the live path reaches through scanPane. */
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

// Agents whose composer we can tell is drawn; others are never "starting up".
const COMPOSER_AGENTS: ReadonlySet<AgentKind | undefined> = new Set(["claude", "codex", "grok", "opencode", "antigravity"]);

// OpenCode draws its composer (and every message and dialog after it) as a bar of ┃ or ╹ rows, not a
// chevron; its footer is not a signal, a small pane drops it. Measured: blank for over 2.5 s on a cold start.
const OPENCODE_BAR_RE = /^\s*[┃╹]/;
const OPENCODE_EDGE_RE = /^\s*╹/;
const OPENCODE_ROW_RE = /^\s*┃/;

// agy 1.2.14's composer: a ">" row between two rules, then its "? for shortcuts" row, ending the screen
// (tests/fixtures/own-screens/agy-idle). Any other screen (a dialog, the palette, a turn) takes no message.
const ANTIGRAVITY_COMPOSER_RE = /(?:^|\n)\s*─{8,}\n>([^\n]*)\n\s*─{8,}\n\s*\?\s*for shortcuts[^\n]*$/;

/** What is typed in Antigravity's composer ("" when empty), or null when its composer is not what the screen ends with. */
function antigravityComposer(rows: readonly string[]): string | null {
  const match = rows.filter((row) => row.trim()).join("\n").match(ANTIGRAVITY_COMPOSER_RE);
  return match ? match[1].trim() : null;
}

// codex-cli 0.159.3 draws a composer under its braille splash ~0.35 s before its trust dialog: under the splash it counts
// once the screen settles. The busy spinner is one braille cell, the logo rows many.
const CODEX_SPLASH_RE = /[\u2800-\u28FF]{8,}/;

function screenSettled(pane: VtPane): boolean {
  const now = Date.now();
  // Blank is not settled: a cold start draws late.
  return (pane.lastOutputAt !== null && now - pane.lastOutputAt >= SCREEN_SETTLE_MS) || now - pane.openedAt >= SCREEN_SETTLE_MAX_MS;
}

/** Whether this screen shows the composer the pane's first message may go to. */
function firstComposer(pane: VtPane, chevron: ComposerState, rows: readonly string[]): boolean {
  if (pane.agent === "opencode") return rows.some((row) => OPENCODE_BAR_RE.test(row));
  if (pane.agent === "antigravity") return antigravityComposer(rows) !== null;
  // A numbered choice wears the composer's chevron but is a dialog: the composer comes after it.
  if (chevron !== "empty" && chevron !== "draft") return false;
  return pane.agent !== "codex" || !rows.some((row) => CODEX_SPLASH_RE.test(row)) || screenSettled(pane);
}

// OpenCode's idle placeholder: `Ask anything… "<example>"`, whole, or clipped by a narrow pane.
// A draft that only starts with those words ("Ask anything about ...") is the user's text.
const OPENCODE_PLACEHOLDER_RE = /^Ask anything(?:(?:…|\.\.\.)(?:\s+".*)?)?$/;

/** Whether OpenCode's composer holds text. The composer is the run of ┃ rows closed by the lowest
 *  ╹ edge; its last row is the agent and model line, the rest is padding and what was typed. */
function opencodeDraft(pane: VtPane, rows: readonly string[]): boolean {
  if (pane.agent !== "opencode") return false;
  let edge = rows.length - 1;
  while (edge >= 0 && !OPENCODE_EDGE_RE.test(rows[edge] ?? "")) edge -= 1;
  if (edge < 0) return false;
  let first = edge;
  while (first > 0 && OPENCODE_ROW_RE.test(rows[first - 1] ?? "")) first -= 1;
  const typed = rows.slice(first, Math.max(first, edge - 1)).map((row) => row.replace(OPENCODE_ROW_RE, "").trim());
  return typed.some((text) => text !== "" && !OPENCODE_PLACEHOLDER_RE.test(text));
}

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
    let cursorHead = false;
    let dimAfter = false;
    for (let x = prompt[0].length; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const chars = cell.getChars();
      if (cell.isDim()) dimAfter ||= typed !== "" && chars.trim() !== "";
      else if (chars !== "") {
        typed += chars;
        cursorHead = typed === chars && cell.isInverse() !== 0;
      }
    }
    // A focused CLI paints its cursor as an inverse cell: on an empty composer, the first
    // letter of the dim placeholder. A lone inverse letter with nothing dim after it is a draft.
    if (cursorHead && dimAfter) return "empty";
    return typed.replace(FRAME_RE, "") !== "" ? "draft" : "empty";
  }
  return "absent";
}

// xterm parses writes asynchronously; an empty write's callback fires once the queue is applied.
const applied = (pane: VtPane): Promise<void> => new Promise((done) => pane.terminal.write("", done));

// Glyphs a composer draws around the typed text: its prompt chevron and box or bar edges.
const COMPOSER_EDGE = /^[\s│┃❯›]+|[\s│┃]+$/g;
const squash = (text: string): string => text.replace(/\s+/g, "");

const edgesOf = (row: string): string => [...row.matchAll(COMPOSER_EDGE)].map((m) => m[0]).join("");

/** Blanks the rows showing only `pasted` (our text is no prompt), keeping the composer's edges; the whole text over
 *  consecutive rows, lowest first, so a dialog quoting one sentence of it is still read. */
function withoutPasted(rows: readonly string[], pasted: string): readonly string[] {
  const want = squash(pasted);
  if (!want) return rows;
  const cells = rows.map((row) => squash(row.replace(COMPOSER_EDGE, "")));
  for (let last = rows.length - 1; last >= 0; last -= 1) {
    let seen = "";
    for (let first = last; first >= 0 && seen.length < want.length; first -= 1) {
      seen = cells[first] + seen;
      if (seen === want) return rows.map((row, y) => (y >= first && y <= last ? edgesOf(row) : row));
    }
  }
  return rows;
}

/** Why a message must not be typed into this pane now, or null. `pasted` is the text Aya
 *  just typed: the composer showing only it is neither a prompt nor a user's draft. */
export async function paneHold(ptyId: string, pasted?: string): Promise<string | null> {
  const pane = panes.get(ptyId);
  // Every live PTY has a mirror; none means it exited or never started.
  if (!pane) return HOLD_NOT_RUNNING;
  await applied(pane);
  if (pane.shell) return HOLD_SHELL;
  const screen = screenRows(pane.terminal);
  const rows = pasted ? withoutPasted(screen, pasted) : screen;
  const composer = composerState(pane.terminal);
  const dialog = evaluateScreen(rows, pane.agent) === "waiting" ? (asksToRunAya(rows) ? HOLD_APPROVE_AYA : HOLD_APPROVAL) : composer === "numbered-choice" ? HOLD_CHOICE : null;
  // Only while its dialog is up: once answered, the message left in the transcript is history.
  if (dialog) return screenShowsUsageLimit(rows, pane.agent) ? HOLD_USAGE_LIMIT : dialog;
  if (firstComposer(pane, composer, screen)) pane.composerSeen = true;
  // Measured: a message typed before the composer is drawn goes nowhere.
  if (!pane.composerSeen && COMPOSER_AGENTS.has(pane.agent)) return HOLD_STARTING;
  if (composer === "draft" && pasted && composerIsPasted(screen, rows)) return null;
  if (composer === "draft" || opencodeDraft(pane, rows)) return HOLD_DRAFT;
  if (pane.agent === "antigravity") {
    const typed = antigravityComposer(rows);
    if (typed === null) return HOLD_BUSY;
    if (typed !== "") return HOLD_DRAFT;
  }
  // Only an agent with no composer rule gets here unseen.
  if (!pane.composerSeen) {
    if (!screenSettled(pane)) return HOLD_STARTING;
    pane.composerSeen = true;
  }
  return null;
}

/** Whether the lowest prompt row, the composer, holds only the text `withoutPasted` blanked. */
function composerIsPasted(shown: readonly string[], masked: readonly string[]): boolean {
  for (let y = shown.length - 1; y >= 0; y -= 1) {
    if (COMPOSER_RE.test(shown[y] ?? "")) return masked[y] !== shown[y];
  }
  return false;
}

/** Whether the pane's agent is mid-turn: typed text would only queue in its CLI. */
export async function paneBusy(ptyId: string): Promise<boolean> {
  const pane = panes.get(ptyId);
  if (!pane) return false;
  await applied(pane);
  return screenIsBusy(screenRows(pane.terminal), pane.agent);
}

export function __testVtPane(ptyId: string): VtPane | undefined {
  return panes.get(ptyId);
}

/** Force a scan without waiting for the debounce. Tests only - production
 *  always goes through writeVtPane's timer. */
export function __testScanVtPane(ptyId: string): void {
  scanPane(ptyId);
}
