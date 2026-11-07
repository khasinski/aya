// What a Conversation GUI pane tells the rest of Aya (status rail, attention centre, sidebar dot): the same four levels
// a terminal agent reports with `aya status`, so a pane waiting for an approval looks the same in either mode.

import type { ControlStatusLevel } from "./types";

export interface GuiPaneStatusInput {
  agentLabel: string;
  /** The agent session is connected. */
  ready: boolean;
  /** A turn is running. */
  busy: boolean;
  /** Pending approvals or questions, newest last; `text` is what the card shows (a command, a question). */
  requests: ReadonlyArray<{ kind: "approval" | "question"; text: string }>;
  /** A question the agent asked in a message and the user has not answered. */
  unansweredQuestion?: string;
  turnOutcome: "complete" | "interrupted" | "failed" | null;
  /** Queued messages are held (after a stop, an error or a reconnect). */
  queueHeld: boolean;
  queued: number;
}

export type GuiPaneStatus = { level: ControlStatusLevel; text: string } | "clear";

const oneLine = (text: string, max = 120): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The status for a pane, or "clear" when it is idle with nothing to say (the sidebar falls back to the process). */
export function guiPaneStatus(input: GuiPaneStatusInput): GuiPaneStatus {
  const { agentLabel } = input;
  if (input.requests.length > 0) {
    const first = input.requests[0]!;
    const more = input.requests.length > 1 ? ` (+${input.requests.length - 1} more)` : "";
    const what = first.kind === "approval" ? "Approval needed" : `${agentLabel} has a question`;
    const detail = oneLine(first.text);
    return { level: "waiting", text: `${what}${detail ? `: ${detail}` : ""}${more}` };
  }
  if (input.unansweredQuestion) return { level: "waiting", text: `${agentLabel} has a question: ${oneLine(input.unansweredQuestion)}` };
  if (!input.ready) return "clear";
  if (input.busy) return { level: "active", text: `${agentLabel} is working` };
  if (input.turnOutcome === "failed") return { level: "error", text: `${agentLabel}'s turn failed` };
  if (input.turnOutcome === "complete") {
    return { level: "done", text: input.queueHeld && input.queued > 0 ? `Turn complete · ${input.queued} queued message${input.queued === 1 ? "" : "s"} held` : "Turn complete" };
  }
  return "clear";
}

/** True when two statuses read the same, so an effect does not re-report on every render. */
export function sameGuiPaneStatus(a: GuiPaneStatus | null, b: GuiPaneStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b || a === "clear" || b === "clear") return false;
  return a.level === b.level && a.text === b.text;
}
