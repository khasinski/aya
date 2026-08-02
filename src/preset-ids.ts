// Well-known preset ids referenced by BEHAVIOR, not just display. These must
// match the ids in electron/presets.ts (built-ins) or the id a user gives a
// preset (gemini) - renaming either side silently disables the behavior keyed
// on it, so the ids live here as named constants and a test cross-checks the
// built-in ones against DEFAULT_PRESETS.
export const PRESET_ID_CODEX = "codex";
/** Not a built-in: matches a user-added Gemini preset by conventional id. */
export const PRESET_ID_GEMINI = "gemini";
