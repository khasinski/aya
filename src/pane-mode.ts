// A pane of an agent with a Conversation GUI (Claude, Codex, Pi, Antigravity) runs either as a terminal or as a
// Conversation, and switches between the two in place (usePaneModeSwitch). The preset only picks the first mode.

import { guiSupportedAgent, type GuiSupportedAgent } from "./agentPreset";
import type { Preset, TerminalState } from "./types";

export type PaneMode = "terminal" | "gui";

/** Fired on window with the pane id as detail: the view showing that pane switches it (header toggle, ⌘⌥G, menu). */
export const PANE_MODE_SWITCH_EVENT = "aya:pane-mode-switch";

/** Menu and header text for the shortcut. */
export const PANE_MODE_SHORTCUT_LABEL = "⌘⌥G";

/** Whether a pane of this preset can be a Conversation at all: a GUI agent, on this machine. */
export function paneCanSwitchMode(preset: Pick<Preset, "agent" | "command">, remote: boolean): GuiSupportedAgent | null {
  return remote ? null : guiSupportedAgent(preset);
}

/** The mode a pane shows: its own choice, else the preset's "Opens as"; always the terminal where there is no GUI. */
export function paneMode(
  preset: Pick<Preset, "agent" | "command" | "interfaceMode">,
  terminal: Pick<TerminalState, "interfaceMode"> | undefined,
  remote: boolean,
): PaneMode {
  if (!paneCanSwitchMode(preset, remote)) return "terminal";
  return (terminal?.interfaceMode ?? preset.interfaceMode) === "gui" ? "gui" : "terminal";
}

/** The mode a new pane of `preset` records, so a later change of the preset's default never flips a live pane;
 *  undefined for a preset without a GUI. */
export function initialPaneMode(preset: Pick<Preset, "agent" | "command" | "interfaceMode">, remote: boolean): PaneMode | undefined {
  return paneCanSwitchMode(preset, remote) ? (preset.interfaceMode === "gui" ? "gui" : "terminal") : undefined;
}

/** Why a terminal pane cannot switch to its Conversation right now, or null when it can. */
export function terminalSwitchRefusal(
  t: Pick<TerminalState, "status" | "working" | "externalStatus" | "exitCode" | "disconnected" | "stopped" | "spawnFailure" | "remoteHost" | "spawnDeferred">,
): string | null {
  if (t.remoteHost) return "A remote pane stays a terminal.";
  if (t.disconnected) return "Wait for the terminal to reconnect before switching.";
  const live = t.exitCode === null && !t.stopped && !t.spawnFailure && !t.spawnDeferred;
  if (!live) return null;
  if (t.status === "waiting" || t.externalStatus?.level === "waiting") return "Answer the agent's prompt in the terminal before switching.";
  if (t.working === true || t.externalStatus?.level === "active") return "Wait for the turn to finish, or stop it, before switching.";
  return null;
}

/** Why a Conversation pane cannot switch to the terminal right now, or null when it can. */
export function conversationSwitchRefusal(state: { busy: boolean; requests: number; switching: boolean; connecting: boolean }): string | null {
  if (state.connecting || state.switching) return "Wait for the conversation to finish connecting before switching.";
  if (state.requests > 0) return "Answer the pending approval or question before switching.";
  if (state.busy) return "Wait for the turn to finish, or stop it, before switching.";
  return null;
}
