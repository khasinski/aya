import { boolPreference, enumPreference, type PreferenceCodec } from "./preference-codecs";
import {
  DEFAULT_MAC_OPTION_KEY_MODE,
  isMacOptionKeyMode,
  type MacOptionKeyMode,
} from "./terminal-option-key";
import { TERMINAL_FONT_FAMILY_STORAGE_KEY } from "./storage-keys";
import type { LayoutMode } from "./types";

export type AppThemePreference = "system" | "light" | "dark" | "omarchy" | "violet";



// localStorage codecs for the simple preferences (see usePersistentPreference).
export const THEME_CODEC = enumPreference<AppThemePreference>(
  ["system", "light", "dark", "omarchy", "violet"],
  "system",
);
export const MAC_OPTION_CODEC: PreferenceCodec<MacOptionKeyMode> = {
  fallback: DEFAULT_MAC_OPTION_KEY_MODE,
  parse: (raw) => (isMacOptionKeyMode(raw) ? raw : DEFAULT_MAC_OPTION_KEY_MODE),
  serialize: (v) => v,
};
// "classic" (default): project tabs on top, terminal list left.
// "projects-left": project tabs in a left rail, terminal tabs on top.
export const LAYOUT_CODEC = enumPreference<LayoutMode>(
  ["classic", "projects-left"],
  "classic",
);
// Harness names show by default; the PR/branch link is opt-in (needs gh).
export const HARNESS_NAME_CODEC = boolPreference(true);
export const GITHUB_LINK_CODEC = boolPreference(false);
// Experimental: git worktree support (detect + group + launch/create in worktrees).
// Experimental: Cmd+F "History" mode searching Claude/Codex session
// transcripts on disk for the tab's cwd.
export const HARNESS_SEARCH_CODEC = boolPreference(false);
// Waiting/done chimes default on; the settings toggle is an opt-out.
export const TERMINAL_SOUNDS_CODEC = boolPreference(true);
// The status rail starts expanded - it only renders at all when something
// actually needs attention, so hiding it by default would defeat the point.
export const STATUS_RAIL_COLLAPSED_CODEC = boolPreference(false);
// Per-preset chime exceptions ({presetId: false}) and custom audio paths.
// Stored as JSON because they're maps/nullable strings, not flags.
export const SOUND_OVERRIDES_CODEC: PreferenceCodec<Record<string, boolean>> = {
  fallback: {},
  parse: (raw) => {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const out: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "boolean") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  },
  serialize: (value) => JSON.stringify(value),
};
export const SOUND_PATH_CODEC: PreferenceCodec<string | null> = {
  fallback: null,
  parse: (raw) => (raw.trim() ? raw : null),
  serialize: (value) => value ?? "",
};

export function readTerminalFontFamily(): string {
  return localStorage.getItem(TERMINAL_FONT_FAMILY_STORAGE_KEY) ?? "";
}

