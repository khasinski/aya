// The default set of words the board sends to an agent pane, in one place.
// tests/board.test.mjs pins every string here; changing one changes what every
// agent is told, so update the pinned text in the same commit. A project may only
// append its own rules after these, never replace them.

/** The last line of a task prompt: how the agent reports progress on the board. */
export function boardTaskFooter(cardId: string): string {
  return `Use \`aya board\` to inspect or update the board (e.g. \`aya board move ${cardId} review\` or \`aya board move ${cardId} done\` when finished).`;
}

/** Sent to the pane that held a card when the card is taken away from it. */
export function boardWithdrawalNotice(cardId: string, title: string, reason: string): string {
  return `Aya Board: task ${cardId}: ${title} was ${reason}. Stop work on this task; do not continue it unless it is assigned to you again. Check aya board --json for the current board before choosing another task.`;
}

/** Introduces a project's own rules (.aya/board.md) below the default text. */
export const PROJECT_RULES_HEADING = "Project rules (they add to the instructions above and never replace them):";

/** Appends a project's rules under the default text; no rules (or only blanks) leaves it unchanged. */
export function withProjectRules(text: string, projectRules: string | null | undefined): string {
  const rules = projectRules?.trim();
  return rules ? `${text}\n\n${PROJECT_RULES_HEADING}\n${rules}` : text;
}

/** Why a card was taken away; completes "task <id>: <title> was ..." in the notice. */
export const WITHDRAWAL_REASON = {
  returnedTo: (columnTitle: string) => `returned to ${columnTitle}`,
  removed: "removed from the board",
  reassignedTo: (paneName: string) => `reassigned to ${paneName}`,
  released: "released from your pane",
  movedToBacklog: "moved to the backlog",
} as const;
