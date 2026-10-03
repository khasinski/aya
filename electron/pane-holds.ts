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

/** The agent waits on its own CLI's dialog: the user has to answer it. */
const DIALOG_HOLDS: ReadonlySet<string> = new Set([HOLD_APPROVAL, HOLD_CHOICE, HOLD_APPROVE_AYA, HOLD_USAGE_LIMIT]);
export const isDialogHold = (hold: string | null | undefined): hold is string => !!hold && DIALOG_HOLDS.has(hold);
