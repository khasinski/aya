import type { TeamRunStatus } from "./team-records";

/** Current state and the next step, shared by whoami and show. Reads never change the team. */
export function teamLiveGuidance(team: string, status: TeamRunStatus, role: string | null): string[] {
  const line = `state     ${status.state}${status.pausedBy ? ` (paused by ${status.pausedBy})` : ""} (current Aya state)`;
  const recheck = "This is a current-state snapshot. Recheck with aya team show before acting on older pause messages or refused sends.";
  if (status.state === "running") return [line, "The team is already running; use aya team send for assigned work, not another start or resume.", recheck];
  if (status.state === "not started") return [line, `The team has not started; start it only on the user's request: aya team start ${team}.`, recheck];
  if (status.pausedBy === "user") return [line, "Only the user can resume this team; do not bypass the user's pause.", recheck];
  const resume = role === status.pausedBy
    ? `You paused this team; you can resume it when the user asks to continue: aya team start ${team}.`
    : `Only ${status.pausedBy} or the user can resume this team.`;
  return [line, resume, recheck];
}
