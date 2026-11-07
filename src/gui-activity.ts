// The tool calls of a turn, grouped into phases: consecutive calls of one kind read as one step ("Commands · 3 · 4.1s").

import { formatElapsed } from "./gui-status";

export type ActivityKind = "command" | "edit" | "web" | "tool";

export interface ActivityTiming {
  kind: ActivityKind;
  startedAt?: number;
  endedAt?: number;
}

export function activityKind(itemType: string): ActivityKind {
  if (itemType === "commandExecution") return "command";
  if (itemType === "fileChange") return "edit";
  if (itemType === "webSearch") return "web";
  return "tool";
}

const KIND_LABEL: Record<ActivityKind, string> = { command: "Commands", edit: "File edits", web: "Web searches", tool: "Tools" };

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
