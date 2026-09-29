// Every localStorage key the renderer uses. A stored key outlives a release:
// renaming one resets that preference, so tests/storage-keys.test.mjs pins them.

export const APP_THEME_STORAGE_KEY = "aya:app-theme";
export const MAC_OPTION_KEY_STORAGE_KEY = "aya:mac-option-key";
export const TERMINAL_FONT_FAMILY_STORAGE_KEY = "aya:terminal-font-family";
export const USAGE_HARNESS_NAME_STORAGE_KEY = "aya:usage-show-harness-name";
export const STATUSBAR_GITHUB_LINK_STORAGE_KEY = "aya:statusbar-github-link";
export const LAYOUT_MODE_STORAGE_KEY = "aya:layout-mode";
export const WORKTREES_STORAGE_KEY = "aya:worktrees";
export const HARNESS_SEARCH_STORAGE_KEY = "aya:harness-search";
export const TERMINAL_SOUNDS_STORAGE_KEY = "aya:terminal-sounds";
export const STATUS_RAIL_COLLAPSED_STORAGE_KEY = "aya:status-rail-collapsed";
export const SOUND_OVERRIDES_STORAGE_KEY = "aya:terminal-sound-overrides";
export const CUSTOM_WAITING_SOUND_STORAGE_KEY = "aya:terminal-sound-waiting";
export const CUSTOM_DONE_SOUND_STORAGE_KEY = "aya:terminal-sound-done";
export const LOCAL_SUMMARIES_STORAGE_KEY = "aya:local-summaries";
export const LOCAL_SUMMARY_CACHE_STORAGE_KEY = "aya:local-summary-cache";
export const AYA_INTELLIGENCE_STORAGE_KEY = "aya:intelligence";
export const NO_HARNESS_HINT_DISMISSED_STORAGE_KEY = "aya:no-harness-hint-dismissed";
/** "1" logs every keystroke a terminal sends, for debugging input handling. */
export const DEBUG_TERMINAL_INPUT_STORAGE_KEY = "aya:debug-terminal-input";

/** A project whose .aya launchers the user ignored or already imported. */
export function repoConfigIgnoredKey(directory: string): string {
  return `aya:repo-config-ignored:${directory}`;
}
