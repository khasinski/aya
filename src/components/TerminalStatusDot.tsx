import type { TerminalState } from "../types";

type StatusDotTerminal = Pick<
  TerminalState,
  "name" | "status" | "stopped" | "disconnected" | "remoteDisconnected" | "spawnFailure" | "exitCode"
>;

export function terminalStatusDotText(terminal: StatusDotTerminal): string {
  if (terminal.remoteDisconnected) {
    return "Remote terminal is disconnected. Aya is trying to reconnect.";
  }
  if (terminal.disconnected) {
    return "Terminal is disconnected. Select it to view recovery options.";
  }
  if (terminal.status === "error") {
    return terminal.spawnFailure
      ? "Terminal could not start. Select it to view the error."
      : "Terminal needs attention. Select it to view details.";
  }
  if (terminal.status === "waiting") {
    return "Terminal is waiting for your input. Select it to respond.";
  }
  if (terminal.status === "running") return "Terminal is running.";
  if (terminal.stopped) return "Terminal is stopped. Press Shift+Enter to restart it.";
  if (terminal.exitCode !== null) {
    return terminal.exitCode === 0
      ? "Terminal finished successfully."
      : `Terminal exited with code ${terminal.exitCode}.`;
  }
  return "Terminal is idle.";
}

export function TerminalStatusDot({
  terminal,
  recentlyActive = false,
}: {
  terminal: StatusDotTerminal;
  recentlyActive?: boolean;
}) {
  const text = terminalStatusDotText(terminal);
  return (
    <span
      className={`aya-sidebar-statusdot aya-sidebar-statusdot--${terminal.remoteDisconnected ? "disconnected" : terminal.status}${
        recentlyActive && !terminal.remoteDisconnected ? " aya-sidebar-statusdot--blinking" : ""
      }`}
      role="img"
      aria-label={`${terminal.name}: ${text}`}
      title={text}
    />
  );
}
