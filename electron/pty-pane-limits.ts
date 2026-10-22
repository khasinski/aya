/** One source of truth for native-owner, checkpoint and recovery pane counts. */
export const MAX_PTY_PANES = 128;

/** Shared user-facing copy for a terminal rejected by the PTY pane cap. */
export function paneLimitFailureMessage(): string {
  return `Aya can run at most ${MAX_PTY_PANES} terminals at once. Close a terminal you no longer need, then restart this tab.`;
}
