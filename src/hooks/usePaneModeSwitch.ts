// Terminal ⇄ Conversation for one pane (src/pane-mode.ts). The pane keeps its id, place, cwd, name and team role;
// only the process behind it changes, and the new one resumes the same agent session.

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { cancelPendingTerminalAttach } from "../pending-terminal-attach";
import { paneCanSwitchMode, paneMode, PANE_MODE_SWITCH_EVENT, terminalSwitchRefusal } from "../pane-mode";
import { findProject } from "../project-helpers";
import { forgetSpawn } from "../spawnSession";
import { terminalKillRefusal } from "../terminal-kill-refusal";
import { getPreset, type Preset, type ProjectConfig, type ProjectEvent, type TerminalState } from "../types";

const SAFE_SESSION_ID = /^[A-Za-z0-9_.:/-]{1,200}$/;

interface Options {
  terminalsRef: RefObject<Record<string, TerminalState>>;
  projectsRef: RefObject<ProjectConfig[]>;
  presetsRef: RefObject<Preset[]>;
  setTerminals: Dispatch<SetStateAction<Record<string, TerminalState>>>;
  appendProjectEvent: (event: Omit<ProjectEvent, "id" | "createdAt"> & { createdAt?: number }) => void;
}

/** What a pane needs to start fresh in its other mode, with every trace of the old process cleared. */
const restarted = (t: TerminalState): TerminalState => ({
  ...t, exitCode: null, status: "running", bell: false, spawnFailure: undefined, stopped: undefined, working: undefined,
  externalStatus: undefined, screenDialog: undefined, disconnected: undefined, disconnectedReason: undefined,
  recoveryGeneration: undefined, recoveryNotice: undefined, recoveryScreenUnknown: undefined, recoveryBlocked: undefined,
  recoveryRetryable: undefined, spawnDeferred: undefined,
});

export function usePaneModeSwitch({ terminalsRef, projectsRef, presetsRef, setTerminals, appendProjectEvent }: Options) {
  const paneContext = useCallback((id: string) => {
    const t = terminalsRef.current[id];
    if (!t) return null;
    const project = findProject(projectsRef.current, t.projectSlug);
    const preset = getPreset(presetsRef.current, t.presetId);
    const agent = paneCanSwitchMode(preset, !!project?.remote);
    return { t, preset, agent, mode: paneMode(preset, t, !!project?.remote) };
  }, [terminalsRef, projectsRef, presetsRef]);

  /** Stop the pane's terminal agent and open its Conversation on the same session. Resolves to why it did not. */
  const switchToConversation = useCallback(async (id: string): Promise<string | null> => {
    const pane = paneContext(id);
    if (!pane) return "The pane is gone.";
    const { t, preset, agent } = pane;
    if (!agent) return "This agent has no Conversation view here.";
    if (!window.ayaGui) return "The Conversation view needs the Aya desktop app.";
    const refusal = terminalSwitchRefusal(t);
    if (refusal) return refusal;
    if (t.exitCode === null && !t.stopped && !t.spawnDeferred) {
      const release = cancelPendingTerminalAttach(id);
      try { await window.aya.ptyKill(id); }
      catch (error) { return terminalKillRefusal("restart", t.name, error); }
      finally { release(); }
    }
    forgetSpawn(id);
    try {
      await window.ayaGui.invoke(id, "adopt-terminal-session", { cwd: t.cwd, configDir: preset.configDir, agent, sessionId: t.sessionId });
    } catch (error) {
      // The terminal is stopped either way; the Conversation still opens, on a new session.
      console.error("Could not carry the terminal session over", error);
    }
    setTerminals((prev) => {
      const cur = prev[id];
      return cur ? { ...prev, [id]: { ...restarted(cur), interfaceMode: "gui", resumeOnSwitch: undefined } } : prev;
    });
    appendProjectEvent({ projectSlug: t.projectSlug, terminalId: id, level: "active", title: `${t.name} switched to Conversation` });
    return null;
  }, [paneContext, setTerminals, appendProjectEvent]);

  /** The Conversation stopped its agent (ConversationView, 'detach-for-terminal'): start the terminal on `sessionId`. */
  const completeSwitchToTerminal = useCallback((id: string, sessionId?: string) => {
    const t = terminalsRef.current[id];
    if (!t) return;
    forgetSpawn(id);
    const resume = sessionId && SAFE_SESSION_ID.test(sessionId) ? sessionId : undefined;
    setTerminals((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const { sessionId: _old, ...rest } = restarted(cur);
      return { ...prev, [id]: { ...rest, ...(resume ? { sessionId: resume } : {}), interfaceMode: "terminal", resumeOnSwitch: true } };
    });
    appendProjectEvent({ projectSlug: t.projectSlug, terminalId: id, level: "active", title: `${t.name} switched to Terminal` });
  }, [terminalsRef, setTerminals, appendProjectEvent]);

  /** ⌘⌥G / View menu: the view that shows the pane runs the switch, since only a Conversation knows its turn state. */
  const requestPaneModeSwitch = useCallback((id: string | null | undefined) => {
    if (!id || !paneContext(id)?.agent) return;
    window.dispatchEvent(new CustomEvent(PANE_MODE_SWITCH_EVENT, { detail: id }));
  }, [paneContext]);

  return { switchToConversation, completeSwitchToTerminal, requestPaneModeSwitch };
}
