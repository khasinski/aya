// Hold reasons the terminal host gives that other code names: a new team pane is
// waited on through the first two, any other hold is reported at once.

export const HOLD_NOT_RUNNING = "is not running (exited, or its tab was not opened yet)";
export const HOLD_STARTING = "is still starting up";
// Not the host's: a role whose pane was closed or never given.
export const NO_PANE_HOLD = "no pane assigned";
export const HOLD_DRAFT = "has text the user is typing";
// A round is not typed to an agent mid-turn: its CLI would queue one per tick.
export const HOLD_BUSY = "is busy working";
export const HOLD_APPROVE_AYA = "waiting for you to approve an aya command";
export const HOLD_SHELL = "runs a shell";
export const HOLD_APPROVAL = "shows an approval prompt";
export const HOLD_CHOICE = "shows a numbered choice";
// A dialog saying the CLI ran out: no answer brings the role back, so the hold says why (src/team-view.ts mirrors it).
export const HOLD_USAGE_LIMIT = "is out of credits or at its usage limit";
// A one-time offer whose answer is written to the account's settings: one click in a team pane froze every session on
// that account (2026-10-03), so it is named and left to the user (src/team-view.ts mirrors it).
export const HOLD_ACCOUNT_SETTING =
  "Claude Code offers an account-wide setting: block reads outside the working directories; your choice applies to every session on this account";

/** The agent waits on its own CLI's dialog: the user has to answer it. */
const DIALOG_HOLDS: ReadonlySet<string> = new Set([HOLD_APPROVAL, HOLD_CHOICE, HOLD_APPROVE_AYA, HOLD_USAGE_LIMIT, HOLD_ACCOUNT_SETTING]);
export const isDialogHold = (hold: string | null | undefined): hold is string => !!hold && DIALOG_HOLDS.has(hold);
/** A dialog no agent may answer for the user, not even with `aya pane send`. */
export const isUserOnlyHold = (hold: string | null | undefined): boolean => hold === HOLD_ACCOUNT_SETTING;
