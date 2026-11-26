// The one header bar of an agent pane, in both of its modes: the terminal (TerminalView) and the Conversation
// (ConversationView). Same layout and controls either way: icon and name, what the pane is doing, local servers,
// the Terminal ⇄ Conversation switch and the Artifacts button; controls only a Conversation has go in `actions`.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PANE_MODE_SHORTCUT_LABEL, PANE_MODE_SWITCH_EVENT, type PaneMode } from "../pane-mode";

export interface PaneModeSwitch {
  /** Switches the pane to its other mode; resolves to why it did not, or null. */
  run: () => Promise<string | null>;
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
   *  (`aya present`), which the terminal pane passes in once it has one. */
  artifacts?: ReactNode;
}

export function PaneHeader({ mode, terminalId, icon, color, title, children, status, actions, servers, modeSwitch, artifacts }: Props) {
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(modeSwitch?.run);
  runRef.current = modeSwitch?.run;
  const switchingRef = useRef(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toggle = async () => {
    const run = runRef.current;
    if (!run || switchingRef.current) return;
    switchingRef.current = true; setSwitching(true); setError(null);
    try {
      const why = await run();
      if (why) {
        setError(why);
        if (errorTimer.current) clearTimeout(errorTimer.current);
        errorTimer.current = setTimeout(() => setError(null), 8000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { switchingRef.current = false; setSwitching(false); }
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
  useEffect(() => () => { if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

  const option = (value: PaneMode, label: string, glyph: string) => (
    <button
      type="button"
      className="aya-pane-mode-option"
      aria-label={label}
      aria-pressed={mode === value}
      title={mode === value ? label.replace("Show as", "Showing as") : `${label} (${PANE_MODE_SHORTCUT_LABEL}): stops the agent and resumes the same conversation`}
      disabled={switching}
      onClick={() => { if (mode !== value) void toggle(); }}
    >
      <span className="aya-pane-mode-icon" aria-hidden="true">{glyph}</span>
    </button>
  );
  return (
    <header className={`aya-pane-header aya-pane-header--unified${mode === "gui" ? " aya-gui-header" : ""}`} data-pane-mode={mode}>
      <span className="aya-sidebar-icon" style={color ? { color } : undefined}>{icon}</span>
      <span className="aya-pane-header-title">{title}</span>
      {children}
      <div className="aya-pane-header-meta">{status}</div>
      {error && <span className="aya-pane-mode-error" role="alert">{error}</span>}
      {actions}
      {servers}
      {modeSwitch && (
        <span className="aya-pane-mode" role="group" aria-label="Pane mode" aria-busy={switching || undefined}>
          {option("terminal", "Show as terminal", "terminal")}
          {option("gui", "Show as conversation", "forum")}
        </span>
      )}
      {artifacts}
    </header>
  );
}
