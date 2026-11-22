// The tool calls of a turn, grouped into phases: consecutive calls of one kind read as one step ("Commands · 3 · 4.1s").

import { formatElapsed } from "./gui-status";

export type ActivityKind = "command" | "edit" | "web" | "agent" | "tool";

export interface ActivityTiming {
  kind: ActivityKind;
  startedAt?: number;
  endedAt?: number;
}

export function activityKind(itemType: string): ActivityKind {
  if (itemType === "commandExecution") return "command";
  if (itemType === "fileChange") return "edit";
  if (itemType === "webSearch") return "web";
  if (itemType === "collabAgentToolCall") return "agent";
  return "tool";
}

const firstLine = (value: unknown, max = 80): string => {
  const line = (typeof value === "string" ? value : "").trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a subagent call does, from a Codex `collabAgentToolCall` item (Claude's Agent tool is reported the same way):
 *  "Subagent (Explore): Find the config loader", "Waiting for 2 subagents". */
export function subagentLabel(item: Record<string, unknown>): string {
  const tool = typeof item.tool === "string" ? item.tool : "spawnAgent";
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
  const plural = (n: number) => (n > 1 ? `${n} subagents` : "a subagent");
  if (tool === "spawnAgent") {
    const type = firstLine(item.subagentType, 40);
    const what = firstLine(item.description) || firstLine(item.prompt);
    return `Subagent${type ? ` (${type})` : ""}${what ? `: ${what}` : ""}`;
  }
  if (tool === "wait") return `Waiting for ${plural(receivers)}`;
  if (tool === "sendInput" || tool === "sendMessage" || tool === "followupTask") return `Messaging ${plural(receivers)}`;
  if (tool === "resumeAgent") return `Resuming ${plural(receivers)}`;
  if (tool === "closeAgent") return `Closing ${plural(receivers)}`;
  if (tool === "interruptAgent") return `Stopping ${plural(receivers)}`;
  if (tool === "listAgents") return "Listing subagents";
  return "Using a subagent";
}

/** The last known state of each agent a Codex collab call addressed, one line per agent. */
export function subagentStates(item: Record<string, unknown>): string {
  const states = item.agentsStates && typeof item.agentsStates === "object" ? Object.entries(item.agentsStates as Record<string, unknown>) : [];
  return states.map(([thread, raw]) => {
    const state = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const message = typeof state.message === "string" ? state.message.trim() : "";
    return `${thread}: ${typeof state.status === "string" ? state.status : "unknown"}${message ? `\n${message}` : ""}`;
  }).join("\n\n");
}

const KIND_LABEL: Record<ActivityKind, string> = { command: "Commands", edit: "File edits", web: "Web searches", agent: "Subagents", tool: "Tools" };

/** How long a call took, or null while it runs or when no timing was recorded (an activity restored from disk). */
export function activityDuration(activity: Pick<ActivityTiming, "startedAt" | "endedAt">): number | null {
  if (activity.startedAt === undefined || activity.endedAt === undefined) return null;
  return Math.max(0, activity.endedAt - activity.startedAt);
}

/** A short duration for a row: under a second is "<1s". */
export function shortDuration(ms: number): string {
  return ms < 1000 ? "<1s" : formatElapsed(ms);
}

export interface Phase { index: number; kind: ActivityKind; label: string; count: number; ms: number | null }

/** Phases of consecutive same-kind calls, with their total time (null when none of them has a timing). A lone call is
 *  not a phase: a header over one row says nothing the row does not. */
export function activityPhases(activities: readonly ActivityTiming[]): Phase[] {
  const phases: Phase[] = [];
  let start = 0;
  while (start < activities.length) {
    let end = start + 1;
    while (end < activities.length && activities[end]!.kind === activities[start]!.kind) end++;
    if (end - start > 1) {
      const timings = activities.slice(start, end).map(activityDuration).filter((value): value is number => value !== null);
      const kind = activities[start]!.kind;
      phases.push({ index: start, kind, label: KIND_LABEL[kind], count: end - start, ms: timings.length ? timings.reduce((a, b) => a + b, 0) : null });
    }
    start = end;
  }
  return phases;
}

export function phaseText(phase: Phase): string {
  return [phase.label, String(phase.count), phase.ms === null ? null : shortDuration(phase.ms)].filter(Boolean).join(" · ");
}
