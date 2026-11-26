// Stopping subagents from the Conversation GUI's tool activity.

/** A call that started a subagent (Claude's Agent call, Codex's spawnAgent): its row can stop that subagent. */
export function startsSubagent(item: Record<string, unknown>): boolean {
  return item.type === "collabAgentToolCall" && (item.tool === undefined || item.tool === "spawnAgent");
}

/** A row gets its own Stop button while the subagent it started is running. */
export function canStopSubagent(activity: { stoppable?: boolean; status: string }): boolean {
  return activity.stoppable === true && activity.status === "inProgress";
}

/** The composer's Stop stays while subagents still run after their turn ended, so they can be stopped too. */
export function showStop(busy: boolean, backgroundAgents: number): boolean {
  return busy || backgroundAgents > 0;
}

/** A new turn (a send, an edit from here) starts a fresh activity list, but keeps the background subagents still
 *  running from an earlier turn: their Stop, the status count and their later completion stay on that row. */
export function activitiesForNewTurn<T extends { background?: boolean; status: string }>(activities: T[]): T[] {
  return activities.filter(activity => activity.background === true && activity.status === "inProgress");
}

/** The agent process went away (disconnect, restart): nothing it ran is still running. */
export function interruptActivities<T extends { status: string }>(activities: T[]): T[] {
  return activities.map(activity => activity.status === "inProgress" ? { ...activity, status: "interrupted" } : activity);
}
