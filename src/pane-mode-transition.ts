// The Terminal ⇄ Conversation switch as the user sees it, per pane: the body fades into a calm "Opening
// conversation…" veil, the agent swaps underneath, and the veil fades out only once the new view is ready (the
// Conversation connected with its history, or the terminal's first output). The header never moves: it shows the
// target mode pressed with a spinner while this runs, and any refusal or failure next to the toggle.
// PaneGrid draws the veil (PaneModeVeil), PaneHeader the toggle; usePaneModeSwitch and ConversationView drive it.

import { useSyncExternalStore } from "react";
import type { PaneMode } from "./pane-mode";
import { ptyEventBus } from "./ptyEventBus";

export type PaneModePhase = "covering" | "loading" | "revealing";

export interface PaneModeTransition {
  to: PaneMode;
  phase: PaneModePhase;
  /** "Opening conversation…" / "Starting terminal…". */
  title: string;
  /** "Resuming session" or "Starting a new session" (while Aya does not know yet: "Stopping the conversation"). */
  detail: string;
}

export interface PaneModeState {
  transition: PaneModeTransition | null;
  /** Why the last switch did not happen or did not finish; shown next to the toggle. */
  message: string | null;
  /** The message warns about switching to this mode: a second request to it, while the message shows, overrides it.
   *  A refusal or a failure has none, so a click after one never switches past anything. */
  warning?: PaneMode;
}

/** The veil's fade, both ways; the CSS uses the same value (--aya-pane-mode-fade). */
export const PANE_MODE_FADE_MS = 150;
/** A terminal that prints nothing (a quiet agent, a slow login shell) is shown after this long anyway. */
export const TERMINAL_READY_FALLBACK_MS = 2500;
/** Nothing leaves the veil up longer than this, counted again from the swap (a cold start can take most of it). */
export const SWITCH_TIMEOUT_MS = 20_000;
const TIMEOUT_MESSAGE = "The switch took too long. The pane shows where it got to.";
const MESSAGE_MS = 8000;

const EMPTY: PaneModeState = { transition: null, message: null };
const states = new Map<string, PaneModeState>();
const listeners = new Set<() => void>();
interface Pending { readyRequested: boolean; timers: ReturnType<typeof setTimeout>[]; cleanups: (() => void)[]; timeout?: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();
/** A switch the timeout gave up on: its view may still get ready, which takes the timeout's message back. */
const lateTargets = new Map<string, PaneMode>();
const messageTimers = new Map<string, ReturnType<typeof setTimeout>>();

const reducedMotion = () => {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true; } catch { return false; }
};
const fadeMs = () => (reducedMotion() ? 0 : PANE_MODE_FADE_MS);
/** Two frames: the new view has laid out and painted under the veil before it fades out. */
const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function set(id: string, next: PaneModeState) {
  if (!next.transition && !next.message) states.delete(id); else states.set(id, next);
  for (const listener of listeners) listener();
}
const get = (id: string) => states.get(id) ?? EMPTY;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePaneModeTransition(id: string): PaneModeState {
  return useSyncExternalStore(subscribe, () => get(id));
}

/** Every pane with a switch running, for the veils. */
export function usePaneModeTransitions(): ReadonlyMap<string, PaneModeState> {
  return useSyncExternalStore(subscribe, () => snapshot());
}
let lastSnapshot: Map<string, PaneModeState> = new Map();
let lastVersion = "";
function snapshot() {
  const version = [...states].map(([id, s]) => `${id}:${s.transition?.phase ?? "-"}:${s.transition?.to ?? ""}:${s.transition?.detail ?? ""}`).join("|");
  if (version !== lastVersion) { lastVersion = version; lastSnapshot = new Map(states); }
  return lastSnapshot;
}

/** The pane's switch state outside React. */
export const paneModeState = (id: string): PaneModeState => get(id);

export function paneModeSwitching(id: string): boolean {
  return !!get(id).transition;
}

/** Show why a switch did not happen, next to the toggle, for a while (null clears it). `warning`: the message is a
 *  warning about switching to that mode, which the next request to it overrides. */
export function setPaneModeMessage(id: string, message: string | null, warning?: PaneMode) {
  const timer = messageTimers.get(id);
  if (timer) clearTimeout(timer);
  messageTimers.delete(id);
  const { warning: _old, ...rest } = get(id);
  set(id, { ...rest, message, ...(message && warning ? { warning } : {}) });
  if (message) messageTimers.set(id, setTimeout(() => { messageTimers.delete(id); if (get(id).message === message) set(id, { ...get(id), message: null }); }, MESSAGE_MS));
}

function clearPending(id: string) {
  const p = pending.get(id);
  if (!p) return;
  for (const t of p.timers) clearTimeout(t);
  for (const c of p.cleanups) c();
  pending.delete(id);
}

/** Whether a request to switch to `to` overrides what the header shows: a warning about that same switch. */
export function paneModeWarned(id: string, to: PaneMode): boolean {
  const s = get(id);
  return s.message !== null && s.warning === to;
}

/** Start a switch: the veil fades in over the current view. Resolves once it covers the pane, so the caller swaps
 *  the views only where nobody sees it. A terminal target is ready at its first output (or its exit, or a quiet
 *  fallback after the swap); a Conversation target says so itself (paneModeReady / paneModeFailed). */
export function beginPaneModeSwitch(id: string, to: PaneMode, resuming?: boolean): Promise<void> {
  clearPending(id);
  lateTargets.delete(id);
  const p: Pending = { readyRequested: false, timers: [], cleanups: [] };
  pending.set(id, p);
  set(id, {
    message: null,
    transition: {
      to, phase: "covering",
      title: to === "gui" ? "Opening conversation…" : "Starting terminal…",
      detail: resumingDetail(resuming),
    },
  });
  if (to === "terminal") {
    p.cleanups.push(ptyEventBus.onFor(id, (event) => {
      if (event.type === "data" || event.type === "exit" || event.type === "no-session" || event.type === "spawn-failed") paneModeReady(id);
    }));
  }
  armTimeout(id, p);
  return new Promise((resolve) => {
    p.timers.push(setTimeout(() => {
      const s = get(id);
      if (pending.get(id) !== p || !s.transition) return resolve();
      set(id, { ...s, transition: { ...s.transition, phase: "loading" } });
      resolve();
      if (p.readyRequested) void reveal(id, p);
    }, fadeMs()));
  });
}

const resumingDetail = (resuming: boolean | undefined) =>
  resuming === undefined ? "Stopping the conversation" : resuming ? "Resuming session" : "Starting a new session";

/** Once Aya knows whether the new view resumes a session (a Conversation hands its id over only as it stops). */
export function setPaneModeResuming(id: string, resuming: boolean) {
  const s = get(id);
  if (s.transition) set(id, { ...s, transition: { ...s.transition, detail: resumingDetail(resuming) } });
}

function armTimeout(id: string, p: Pending) {
  if (p.timeout) clearTimeout(p.timeout);
  const to = get(id).transition?.to;
  p.timeout = setTimeout(() => {
    if (pending.get(id) !== p) return;
    if (to) lateTargets.set(id, to);
    paneModeFailed(id, TIMEOUT_MESSAGE);
  }, SWITCH_TIMEOUT_MS);
  p.timers.push(p.timeout);
}

/** The new view is mounted under the veil: the timeout counts from here, since what is slow (a cold start, the
 *  transcript lookup) comes before; a terminal's first output may never come. */
export function paneModeSwapped(id: string) {
  const p = pending.get(id);
  if (!p) return;
  armTimeout(id, p);
  if (get(id).transition?.to === "terminal") p.timers.push(setTimeout(() => paneModeReady(id), TERMINAL_READY_FALLBACK_MS));
}

async function reveal(id: string, p: Pending) {
  await afterPaint();
  const s = get(id);
  if (pending.get(id) !== p || !s.transition || s.transition.phase === "revealing") return;
  set(id, { ...s, transition: { ...s.transition, phase: "revealing" } });
  p.timers.push(setTimeout(() => {
    if (pending.get(id) !== p) return;
    clearPending(id);
    set(id, { ...get(id), transition: null });
  }, fadeMs()));
}

/** The new view is ready: fade the veil out (after the cover finished, if it has not yet). */
export function paneModeReady(id: string) {
  const p = pending.get(id);
  const s = get(id);
  // Ready after all, past the timeout: the switch did finish.
  if (!p && lateTargets.delete(id) && s.message === TIMEOUT_MESSAGE) { setPaneModeMessage(id, null); return; }
  if (!p || !s.transition) return;
  if (s.transition.phase === "covering") { p.readyRequested = true; return; }
  void reveal(id, p);
}

/** The switch failed after it started: show the pane as it is now and say why next to the toggle. */
export function paneModeFailed(id: string, message: string) {
  if (!pending.has(id)) return;
  setPaneModeMessage(id, message);
  paneModeReady(id);
}

/** The switch stopped before the views swapped: the old view comes back as it was. */
export function cancelPaneModeSwitch(id: string) {
  const p = pending.get(id);
  if (!p) return;
  p.readyRequested = true;
  paneModeReady(id);
}

/** Which way a running switch goes, for the view that should report readiness. */
export function paneModeTarget(id: string): PaneMode | null {
  return get(id).transition?.to ?? lateTargets.get(id) ?? null;
}
