// PTY-owned VT mirror. Agent rules are evaluated by the connected main process.
import type { Terminal } from "@xterm/headless";
import { VtCheckpointTerminal } from "./vt-checkpoint";
import type { VtCheckpoint } from "./vt-checkpoint";
import { MIN_PTY_COLS, MIN_PTY_ROWS } from "./pty-core-constants";
import type { AgentKind } from "./presets";
import { RecoveryScreen } from "./vt-recovery-screen";
import { randomUUID } from "node:crypto";
import type { ReplayModeState } from "./pty-replay-modes";
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
  /** Consumed screen was lost in a JS crash; only a proved fresh redraw clears it. */
  recoveryUnknown?: boolean;
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
const checkpointTerminals = new WeakMap<VtPane, VtCheckpointTerminal>();
const recoveryScreens = new WeakMap<VtPane, RecoveryScreen>();

export function openVtPane(
  ptyId: string,
  cols: number,
  rows: number,
  onChange: (waiting: boolean, dialog?: string) => void,
  agent?: AgentKind,
  shell = false,
): void {
  const checkpointTerminal = new VtCheckpointTerminal({
    cols: Math.max(cols, MIN_PTY_COLS), rows: Math.max(rows, MIN_PTY_ROWS),
    scrollback: VT_SCROLLBACK_LINES, allowProposedApi: true,
  });
  const pane: VtPane = {
    terminal: checkpointTerminal.terminal,
    agent,
    shell,
    lastWaiting: false,
    lastDialog: undefined,
    composerSeen: false,
    openedAt: Date.now(),
    lastOutputAt: null,
    timer: null,
    onChange,
  };
  checkpointTerminals.set(pane, checkpointTerminal);
  panes.set(ptyId, pane);
}

export function resizeVtPane(ptyId: string, cols: number, rows: number): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  try {
    checkpointTerminals.get(pane)!.resize(Math.max(cols, MIN_PTY_COLS), Math.max(rows, MIN_PTY_ROWS));
  } catch {
    // A resize can race the pane closing; the next write just lands on the
    // old geometry, which only affects wrapping in the detector's input.
  }
}

export function closeVtPane(ptyId: string): void {
  const pane = panes.get(ptyId);
  if (!pane) return;
  panes.delete(ptyId);
  recoveryScreens.get(pane)?.dispose();
  if (pane.timer) clearTimeout(pane.timer);
  try {
    checkpointTerminals.get(pane)!.dispose();
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
  checkpointTerminals.get(pane)!.write(chunk);
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
  recoveryUnknown?: boolean;
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
  return { generation, ...(pane.recoveryUnknown?{recoveryUnknown:true}:{}), agent: pane.agent, shell: pane.shell, composerSeen: pane.composerSeen,
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
  if (pane && !pane.recoveryUnknown && snapshotGeneration(pane) === generation) pane.composerSeen = true;
}
function snapshotGeneration(pane: VtPane): string { return generations.get(pane) ?? snapshotOf(pane).generation; }

interface VtPaneCheckpointMetadata {
  generation: string;
  agent?: AgentKind;
  shell: boolean;
  lastWaiting: boolean;
  lastDialog?: string;
  composerSeen: boolean;
  openedAt: number;
  lastOutputAt: number | null;
}
const CHECKPOINT_AGENTS = new Set(["claude", "codex", "opencode", "kilo", "pi", "cursor", "copilot", "grok", "droid", "devin", "kimi", "hermes", "qodercli", "antigravity", "custom"]);
export function checkpointMetadata(value: unknown): VtPaneCheckpointMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid VT pane metadata");
  const v = value as Record<string, unknown>;
  const keys = new Set(["generation", "agent", "shell", "lastWaiting", "lastDialog", "composerSeen", "openedAt", "lastOutputAt"]);
  const time = (n: unknown): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (Object.keys(v).some(key => !keys.has(key)) || typeof v.generation !== "string" || !v.generation.length || v.generation.length > 128 ||
      (v.agent !== undefined && (typeof v.agent !== "string" || !CHECKPOINT_AGENTS.has(v.agent))) ||
      typeof v.shell !== "boolean" || typeof v.lastWaiting !== "boolean" || typeof v.composerSeen !== "boolean" ||
      (v.lastDialog !== undefined && (typeof v.lastDialog !== "string" || v.lastDialog.length > 128)) ||
      !time(v.openedAt) || (v.lastOutputAt !== null && !time(v.lastOutputAt))) throw new Error("Invalid VT pane metadata");
  return value as VtPaneCheckpointMetadata;
}

/** The caller first gates PTY producers; this function only drains the mirror. */
export async function checkpointVtPane(id: string): Promise<VtCheckpoint> {
  const pane = panes.get(id);
  if (!pane) throw new Error("VT pane missing during checkpoint");
  if(pane.recoveryUnknown)throw new Error("Screen unknown after the terminal host restarted");
  await checkpointTerminals.get(pane)!.drain();
  const metadata: VtPaneCheckpointMetadata = {
    generation: snapshotGeneration(pane), shell: pane.shell, lastWaiting: pane.lastWaiting,
    composerSeen: pane.composerSeen, openedAt: pane.openedAt, lastOutputAt: pane.lastOutputAt,
    ...(pane.agent === undefined ? {} : {agent: pane.agent}),
    ...(pane.lastDialog === undefined ? {} : {lastDialog: pane.lastDialog}),
  };
  const checkpoint = await checkpointTerminals.get(pane)!.checkpoint(metadata);
  if (panes.get(id) !== pane) throw new Error("VT pane changed during checkpoint");
  return checkpoint;
}

export async function restoreVtPane(id: string, checkpoint: VtCheckpoint, onChange: VtPane["onChange"]): Promise<void> {
  if (panes.has(id)) throw new Error("VT pane already exists during restore");
  const metadata = checkpointMetadata(checkpoint.metadata);
  const tracker = await VtCheckpointTerminal.import(checkpoint);
  if (panes.has(id)) { tracker.dispose(); throw new Error("VT pane appeared during restore"); }
  const pane: VtPane = {
    ...metadata, agent: metadata.agent, lastDialog: metadata.lastDialog,
    terminal: tracker.terminal, timer: null, onChange,
  };
  checkpointTerminals.set(pane, tracker);
  generations.set(pane, metadata.generation);
  panes.set(id, pane);
}
export function vtPaneAltScreen(id: string): boolean | undefined {
  const pane = panes.get(id);
  return pane && pane.terminal.buffer.active.type === "alternate";
}
/** Read the restored mirror's current input modes for legacy replay DTOs
 * which predate serialized replay-boundary state. */
export function vtPaneReplayModeState(id: string): ReplayModeState | undefined {
  const terminal = panes.get(id)?.terminal;
  if (!terminal) return undefined;
  const modes = terminal.modes;
  const internal = terminal as unknown as { _core?: { coreMouseService?: { _activeEncoding?: string } } };
  return {
    alternate: terminal.buffer.active.type === "alternate",
    mouse: modes.mouseTrackingMode,
    sgrMouse: internal._core?.coreMouseService?._activeEncoding === "SGR",
    focus: modes.sendFocusMode,
    bracketedPaste: modes.bracketedPasteMode,
    applicationCursor: modes.applicationCursorKeysMode,
  };
}
export function vtPaneWaiting(id: string): boolean { return panes.get(id)?.lastWaiting ?? false; }
export function vtPaneDialog(id: string): string | undefined { return panes.get(id)?.lastDialog; }

/** Main must nudge SIGWINCH after attach. Coverage follows applied parser work,
 * and stays conservative across scroll, geometry and alternate-buffer changes. */
export function beginVtRecovery(id:string,timeout:()=>void=()=>{},applied:()=>void=()=>{}):void {
 const pane=panes.get(id);if(!pane)throw Error("Recovery mirror is missing");
 pane.recoveryUnknown=true;pane.composerSeen=false;
 recoveryScreens.set(pane,new RecoveryScreen(pane.terminal,(known,timedOut)=>{
  if(panes.get(id)!==pane)return;
  if(known){pane.recoveryUnknown=false;pane.onSnapshot?.(snapshotOf(pane));applied();}
  else if(timedOut)timeout();
 }));
}
