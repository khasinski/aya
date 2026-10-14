// PTY-owned VT mirror. Agent rules are evaluated by the connected main process.
import { Terminal } from "@xterm/headless";
import { MIN_PTY_COLS, MIN_PTY_ROWS } from "./pty-core-constants";
import type { AgentKind } from "./presets";
import { randomUUID } from "node:crypto";
// Only the visible screen matters for "what is on screen right now", and
// scrollback would grow a buffer per pane in the host process for no gain.
const VT_SCROLLBACK_LINES = 0;
// The screen is scanned at most this often per pane. Writes are applied
// immediately; only the (comparatively expensive) scan is rate-limited, so a
// firehose of output costs one scan per interval rather than one per chunk.
export const SCAN_INTERVAL_MS = 250;
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
  /** The dialog's name while one Aya names is up (an account-wide offer), else undefined. */
  lastDialog: string | undefined;
  /** The agent has finished starting: its composer was on screen once, or (no composer rule) its screen settled. */
  composerSeen: boolean;
  /** When the mirror opened and when the pane last wrote (null: nothing yet): a pane with no composer rule is up once quiet. */
  openedAt: number;
  lastOutputAt: number | null;
  /** Pending trailing scan, so a pane that goes quiet right after painting a
   *  prompt still gets scanned once more. */
  timer: ReturnType<typeof setTimeout> | null;
  onChange: (waiting: boolean, dialog?: string) => void;
  onSnapshot?: (snapshot: VtSnapshot) => void;
}

export const panes = new Map<string, VtPane>();

export function openVtPane(
  ptyId: string,
  cols: number,
  rows: number,
  onChange: (waiting: boolean, dialog?: string) => void,
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
    lastDialog: undefined,
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
    const current = panes.get(ptyId);
    if (current === pane) pane.onSnapshot?.(snapshotOf(pane));
  }, SCAN_INTERVAL_MS);
  // Never hold the host process open just to run a screen scan.
  pane.timer.unref?.();
}


/** Only the cell flags read by the composer detector travel across the socket. */
export interface VtSnapshot {
  generation: string;
  agent?: AgentKind;
  shell: boolean;
  composerSeen: boolean;
  openedAt: number;
  lastOutputAt: number | null;
  rows: string[];
  /** Per row, nonblank cell tuples: [column, characters, dim, inverse]. */
  cells: [number, string, number, number][][];
  cols: number;
}
const generations = new WeakMap<VtPane, string>();
export function snapshotOf(pane: VtPane): VtSnapshot {
  let generation = generations.get(pane);
  if (!generation) { generation = randomUUID(); generations.set(pane, generation); }
  const buffer = pane.terminal.buffer.active;
  const rows: string[] = [], cells: VtSnapshot["cells"] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    rows.push(line?.translateToString(true) ?? "");
    const row: VtSnapshot["cells"][number] = [];
    for (let x = 0; line && x < line.length; x++) {
      const c = line.getCell(x);
      if (c && (c.getChars() !== "" || c.isDim() || c.isInverse()))
        row.push([x, c.getChars(), c.isDim(), c.isInverse()]);
    }
    cells.push(row);
  }
  return { generation, agent: pane.agent, shell: pane.shell, composerSeen: pane.composerSeen,
    openedAt: pane.openedAt, lastOutputAt: pane.lastOutputAt, rows, cells, cols: pane.terminal.cols };
}
export async function vtSnapshot(id: string): Promise<VtSnapshot | null> {
  const pane = panes.get(id);
  if (!pane) return null;
  await new Promise<void>((done) => pane.terminal.write("", done));
  return panes.get(id) === pane ? snapshotOf(pane) : null;
}
/** Opaque evaluator state is monotonic, and cannot spill into a respawned pane. */
export function markComposerSeen(id: string, generation: string): void {
  const pane = panes.get(id);
  if (pane && snapshotGeneration(pane) === generation) pane.composerSeen = true;
}
function snapshotGeneration(pane: VtPane): string { return generations.get(pane) ?? snapshotOf(pane).generation; }
export function vtPaneAltScreen(id: string): boolean | undefined {
  const pane = panes.get(id);
  return pane && pane.terminal.buffer.active.type === "alternate";
}
export function vtPaneWaiting(id: string): boolean { return panes.get(id)?.lastWaiting ?? false; }
export function vtPaneDialog(id: string): string | undefined { return panes.get(id)?.lastDialog; }
