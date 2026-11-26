// The one header bar of an agent pane, in both of its modes: the terminal (TerminalView) and the Conversation
// (ConversationView). Same layout and controls either way: icon and name, what the pane is doing, local servers,
// the Terminal ⇄ Conversation switch and the Artifacts button; controls only a Conversation has go in `actions`.
//
// The <header> element itself belongs to the pane, not to the view: one element per pane id, which each view
// renders its content into (a portal) and places at its top or in the stacked layout's slot. A switch swaps the
// views in one commit, so the bar never unmounts, blinks or changes height; only its content changes.

import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { PANE_MODE_SHORTCUT_LABEL, PANE_MODE_SWITCH_EVENT, type PaneMode, type PaneModeSwitchResult } from "../pane-mode";
import { paneModeSwitching, paneModeWarned, setPaneModeMessage, usePaneModeTransition } from "../pane-mode-transition";

export interface PaneModeSwitch {
  /** Switches the pane to its other mode; resolves to why it did not (a warning a second request overrides), or null. */
  run: (force?: boolean) => Promise<PaneModeSwitchResult>;
}

interface Props {
  mode: PaneMode;
  terminalId: string;
  icon: string;
  color?: string;
  title: string;
  /** After the name: the remote host and running process (terminal), the model line (Conversation). */
  children?: ReactNode;
  /** What the pane is doing, right-aligned. */
  status?: ReactNode;
  /** Controls only this mode has (Conversation: view, context, restart, history). */
  actions?: ReactNode;
  /** The local servers badge (AgentServers). */
  servers?: ReactNode;
  /** Absent for a pane that has one mode only (no Conversation GUI for its agent, or a remote project). */
  modeSwitch?: PaneModeSwitch;
  /** The Artifacts button. In a Conversation the artifact drawer toggle; in a terminal the TUI artifacts control
   *  (`aya present`). */
  artifacts?: ReactNode;
  /** Draw the bar here (the stacked layout's top bar) instead of at the top of the view. */
  slot?: HTMLElement | null;
}

const hosts = new Map<string, HTMLElement>();
/** The pane's header element, the same one for every view the pane shows. */
export function paneHeaderElement(terminalId: string): HTMLElement {
  let host = hosts.get(terminalId);
  if (!host) { host = document.createElement("header"); hosts.set(terminalId, host); }
  return host;
}

const mounted = new Map<string, number>();
/** A closed pane's header goes with it. Checked after the commit: a switch unmounts one view's header and mounts the
 *  other's for the same pane in one commit, which keeps the element. */
export function holdPaneHeaderElement(terminalId: string): () => void {
  mounted.set(terminalId, (mounted.get(terminalId) ?? 0) + 1);
  return () => {
    mounted.set(terminalId, (mounted.get(terminalId) ?? 1) - 1);
    queueMicrotask(() => { if (!mounted.get(terminalId)) { mounted.delete(terminalId); hosts.delete(terminalId); } });
  };
}

export function PaneHeader({ mode, terminalId, icon, color, title, children, status, actions, servers, modeSwitch, artifacts, slot = null }: Props) {
  const host = paneHeaderElement(terminalId);
  const anchor = useRef<HTMLDivElement>(null);
  const { transition, message } = usePaneModeTransition(terminalId);
  const shownMode = transition?.to ?? mode;
  const className = `aya-pane-header aya-pane-header--unified${shownMode === "gui" ? " aya-gui-header" : ""}${transition ? " aya-pane-header--switching" : ""}`;
  // Before paint: the old view's cleanup may have detached the bar in this same commit.
  useLayoutEffect(() => {
    const target = slot ?? anchor.current;
    if (!target) return;
    if (host.parentNode !== target) target.appendChild(host);
    return () => { if (host.parentNode === target) host.remove(); };
  }, [host, slot]);
  useLayoutEffect(() => {
    host.className = className;
    host.dataset.paneMode = shownMode;
  });

  const runRef = useRef(modeSwitch?.run);
  runRef.current = modeSwitch?.run;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => holdPaneHeaderElement(terminalId), [terminalId]);
  const toggle = async () => {
    const run = runRef.current;
    if (!run || paneModeSwitching(terminalId)) return;
    // A second request while a warning about this same switch still shows overrides it; a refusal or a failure
    // never does: the user may have dealt with it, and what the warning would say now was never shown.
    const to: PaneMode = modeRef.current === "gui" ? "terminal" : "gui";
    const force = paneModeWarned(terminalId, to);
    setPaneModeMessage(terminalId, null);
    try {
      const why = await run(force);
      if (typeof why === "string") setPaneModeMessage(terminalId, why);
      else if (why) setPaneModeMessage(terminalId, why.warning, to);
    } catch (e) {
      setPaneModeMessage(terminalId, e instanceof Error ? e.message : String(e));
    }
  };
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const switchable = !!modeSwitch;
  useEffect(() => {
    if (!switchable) return;
    const onRequest = (event: Event) => { if ((event as CustomEvent<string>).detail === terminalId) void toggleRef.current(); };
    window.addEventListener(PANE_MODE_SWITCH_EVENT, onRequest);
    return () => window.removeEventListener(PANE_MODE_SWITCH_EVENT, onRequest);
  }, [switchable, terminalId]);

  const option = (value: PaneMode, label: string, glyph: string) => (
    <button
      type="button"
      className="aya-pane-mode-option"
      aria-label={label}
      // Optimistic: the target shows pressed from the click on, with a spinner until it is ready.
      aria-pressed={shownMode === value}
      title={shownMode === value ? label.replace("Show as", "Showing as") : `${label} (${PANE_MODE_SHORTCUT_LABEL}): stops the agent and resumes the same conversation`}
      disabled={!!transition}
      onClick={() => { if (mode !== value) void toggle(); }}
    >
      <span className="aya-pane-mode-icon" aria-hidden="true">{glyph}</span>
      {transition?.to === value && <span className="aya-pane-mode-spinner" aria-hidden="true" />}
    </button>
  );
  const content = (
    <>
      <span className="aya-sidebar-icon" style={color ? { color } : undefined}>{icon}</span>
      <span className="aya-pane-header-title">{title}</span>
      {/* What belongs to one mode fades while the pane switches, so the old mode's details never flash. */}
      <span className="aya-pane-header-detail">{children}</span>
      <div className="aya-pane-header-meta"><span className="aya-pane-header-detail">{status}</span></div>
      {message && <span className="aya-pane-mode-error" role="alert">{message}</span>}
      <span className="aya-pane-header-detail aya-pane-header-actions">{actions}</span>
      {servers}
      {modeSwitch && (
        <span className="aya-pane-mode" role="group" aria-label="Pane mode" aria-busy={transition ? true : undefined}>
          {option("terminal", "Show as terminal", "terminal")}
          {option("gui", "Show as conversation", "forum")}
        </span>
      )}
      {artifacts}
    </>
  );
  return (
    <>
      {!slot && <div ref={anchor} className="aya-pane-header-anchor" />}
      {createPortal(content, host)}
    </>
  );
}
