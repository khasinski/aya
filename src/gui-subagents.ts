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
