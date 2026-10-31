import { SCREEN_WAITING_DETAIL } from "./attention";
import { controlStatusEventTitle } from "./pty-event-reducer";
import type { ProjectEvent, PtyEvent, TerminalState } from "./types";

// Cap on retained entries in the project event timeline.
const MAX_PROJECT_EVENTS = 200;

export type ProjectEventInput = Omit<ProjectEvent, "id" | "createdAt"> & { createdAt?: number };

export function prependProjectEvent(prev: ProjectEvent[], event: ProjectEvent): ProjectEvent[] {
  return [event, ...prev].slice(0, MAX_PROJECT_EVENTS);
}

export function projectEventForPtyEvent(
  event: PtyEvent,
  terminal: Pick<TerminalState, "projectSlug" | "id" | "name">,
): ProjectEventInput | null {
  if (event.type === "spawn-failed") {
    return {
      projectSlug: terminal.projectSlug,
      terminalId: terminal.id,
      level: "error",
      title: `${terminal.name} failed to launch`,
      detail: event.detail,
    };
  }
  if (event.type === "exit") {
    return {
      projectSlug: terminal.projectSlug,
      terminalId: terminal.id,
      level: event.exitCode === 0 ? "done" : "error",
      title:
        event.exitCode === 0
          ? `${terminal.name} exited`
          : `${terminal.name} exited with error`,
      detail: `exit ${event.exitCode}`,
    };
  }
  if (event.type === "vt-status" && event.waiting) {
    return {
      projectSlug: terminal.projectSlug,
      terminalId: terminal.id,
      level: "waiting",
      title: `${terminal.name} is waiting`,
      detail: event.dialog ?? SCREEN_WAITING_DETAIL,
    };
  }
  if (event.type === "osc-status") {
    if (event.level === "clear") return null;
    return {
      projectSlug: terminal.projectSlug,
      terminalId: terminal.id,
      level: event.level === "active" ? "active" : event.level,
      title: controlStatusEventTitle(terminal.name, event.level),
      detail: event.text,
      createdAt: event.updatedAt,
    };
  }
  return null;
}
