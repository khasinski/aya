/** The variables that tie a process to one pane; a process run for no pane must not carry them. */
export const PANE_ENV_VARS = ["AYA_TERMINAL_ID", "AYA_PRESET_ID", "AYA_PROJECT_SLUG", "AYA_PROJECT_DIR"] as const;
