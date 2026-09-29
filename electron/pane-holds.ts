// Hold reasons a pane gives while its agent is not up yet; a new team pane is
// waited on through these, any other hold is reported at once.

export const HOLD_NOT_RUNNING = "is not running (exited, or its tab was not opened yet)";
export const HOLD_STARTING = "is still starting up";
