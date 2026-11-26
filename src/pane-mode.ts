// A pane of an agent with a Conversation GUI (Claude, Codex, Pi, Antigravity) runs either as a terminal or as a
// Conversation, and switches between the two in place (usePaneModeSwitch). The preset only picks the first mode.

import { guiSupportedAgent, type GuiSupportedAgent } from "./agentPreset";
import type { Preset, TerminalState } from "./types";

export type PaneMode = "terminal" | "gui";

/** What a switch request resolves to: null when it switched, else why not, as a refusal (a string) or as a warning
 *  that a second request right after overrides. */
export type PaneModeSwitchResult = string | { warning: string } | null;

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

type SwitchState = Pick<TerminalState, "status" | "working" | "externalStatus" | "exitCode" | "disconnected" | "stopped" | "spawnFailure" | "remoteHost" | "spawnDeferred" | "screenDialog">;

const liveAgent = (t: SwitchState) => t.exitCode === null && !t.stopped && !t.spawnFailure && !t.spawnDeferred;

/** A session id handed from one mode to the other, or undefined when it is not safe to pass on. Claude and Codex
 *  ids name files Aya reads (transcripts, rollouts), so no `/` or `.`; Pi's may be a session file's path. */
export function switchSessionId(agent: GuiSupportedAgent | null, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const safe = agent === "claude" || agent === "codex" ? /^[A-Za-z0-9_-]{1,200}$/ : /^[A-Za-z0-9_.:/-]{1,200}$/;
  return safe.test(sessionId) ? sessionId : undefined;
}

/** Why a terminal pane cannot switch to its Conversation at all right now, or null when it can: a remote pane, a
 *  lost connection, or a CLI dialog on screen (an approval the switch would throw away). */
export function terminalSwitchRefusal(t: SwitchState): string | null {
  if (t.remoteHost) return "A remote pane stays a terminal.";
  if (t.disconnected) return "Wait for the terminal to reconnect before switching.";
  if (liveAgent(t) && t.status === "waiting" && t.screenDialog) return "Answer the agent's prompt in the terminal before switching.";
  return null;
}

/** A reason to think twice before switching, which a second request overrides: what the agent reported (status hook,
 *  `aya status`) or the screen's activity can outlive the turn, so they never block on their own. */
export function terminalSwitchWarning(t: SwitchState): string | null {
  if (!liveAgent(t)) return null;
  if (t.working === true || t.externalStatus?.level === "active") return "The agent may still be working. Switch again to stop it and switch anyway.";
  if (t.status === "waiting" || t.externalStatus?.level === "waiting") return "The agent may be waiting for an answer. Switch again to switch anyway.";
  return null;
}

/** Why a Conversation pane cannot switch to the terminal right now, or null when it can. */
export function conversationSwitchRefusal(state: { busy: boolean; requests: number; switching: boolean; connecting: boolean; queued?: number }): string | null {
  if (state.connecting || state.switching) return "Wait for the conversation to finish connecting before switching.";
  if (state.requests > 0) return "Answer the pending approval or question before switching.";
  if (state.busy) return "Wait for the turn to finish, or stop it, before switching.";
  // The terminal has no queue: the queued prompts (and a resume scheduled for a usage limit's reset) would be lost.
  if (state.queued) return "Send or remove the queued messages before switching.";
  return null;
}
