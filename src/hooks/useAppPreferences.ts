import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import {
  THEME_CODEC,
  MAC_OPTION_CODEC,
  LAYOUT_CODEC,
  HARNESS_NAME_CODEC,
  GITHUB_LINK_CODEC,
  HARNESS_SEARCH_CODEC,
  TERMINAL_SOUNDS_CODEC,
  STATUS_RAIL_COLLAPSED_CODEC,
  SOUND_OVERRIDES_CODEC,
  SOUND_PATH_CODEC,
  readTerminalFontFamily,
} from "../app-preferences";
import {
  APP_THEME_STORAGE_KEY,
  CUSTOM_DONE_SOUND_STORAGE_KEY,
  CUSTOM_WAITING_SOUND_STORAGE_KEY,
  HARNESS_SEARCH_STORAGE_KEY,
  LAYOUT_MODE_STORAGE_KEY,
  MAC_OPTION_KEY_STORAGE_KEY,
  SOUND_OVERRIDES_STORAGE_KEY,
  STATUSBAR_GITHUB_LINK_STORAGE_KEY,
  STATUS_RAIL_COLLAPSED_STORAGE_KEY,
  TERMINAL_FONT_FAMILY_STORAGE_KEY,
  TERMINAL_SOUNDS_STORAGE_KEY,
  USAGE_HARNESS_NAME_STORAGE_KEY,
} from "../storage-keys";
import type { GitHubLink } from "../types";
import { usePersistentPreference } from "./usePersistentPreference";

export function useAppPreferences() {
  const [appThemePreference, setAppThemePreference] = usePersistentPreference(
    APP_THEME_STORAGE_KEY,
    THEME_CODEC,
  );
  const [macOptionKeyMode, setMacOptionKeyMode] = usePersistentPreference(
    MAC_OPTION_KEY_STORAGE_KEY,
    MAC_OPTION_CODEC,
  );
  const [terminalFontFamily, setTerminalFontFamily] =
    useState(readTerminalFontFamily);
  const [showUsageHarnessName, setShowUsageHarnessName] =
    usePersistentPreference(USAGE_HARNESS_NAME_STORAGE_KEY, HARNESS_NAME_CODEC);
  const [showGitHubLink, setShowGitHubLink] = usePersistentPreference(
    STATUSBAR_GITHUB_LINK_STORAGE_KEY,
    GITHUB_LINK_CODEC,
  );
  const [layoutMode, setLayoutMode] = usePersistentPreference(
    LAYOUT_MODE_STORAGE_KEY,
    LAYOUT_CODEC,
  );
  const [harnessSearchEnabled, setHarnessSearchEnabled] =
    usePersistentPreference(HARNESS_SEARCH_STORAGE_KEY, HARNESS_SEARCH_CODEC);
  const [terminalSoundsEnabled, setTerminalSoundsEnabled] =
    usePersistentPreference(TERMINAL_SOUNDS_STORAGE_KEY, TERMINAL_SOUNDS_CODEC);
  const [statusRailCollapsed, setStatusRailCollapsed] = usePersistentPreference(
    STATUS_RAIL_COLLAPSED_STORAGE_KEY,
    STATUS_RAIL_COLLAPSED_CODEC,
  );
  const [terminalSoundOverrides, setTerminalSoundOverrides] =
    usePersistentPreference(SOUND_OVERRIDES_STORAGE_KEY, SOUND_OVERRIDES_CODEC);
  const [customWaitingSound, setCustomWaitingSound] = usePersistentPreference(
    CUSTOM_WAITING_SOUND_STORAGE_KEY,
    SOUND_PATH_CODEC,
  );
  const [customDoneSound, setCustomDoneSound] = usePersistentPreference(
    CUSTOM_DONE_SOUND_STORAGE_KEY,
    SOUND_PATH_CODEC,
  );

  return {
    appThemePreference,
    setAppThemePreference,
    macOptionKeyMode,
    setMacOptionKeyMode,
    terminalFontFamily,
    setTerminalFontFamily,
    showUsageHarnessName,
    setShowUsageHarnessName,
    showGitHubLink,
    setShowGitHubLink,
    layoutMode,
    setLayoutMode,
    harnessSearchEnabled,
    setHarnessSearchEnabled,
    terminalSoundsEnabled,
    setTerminalSoundsEnabled,
    statusRailCollapsed,
    setStatusRailCollapsed,
    terminalSoundOverrides,
    setTerminalSoundOverrides,
    customWaitingSound,
    setCustomWaitingSound,
    customDoneSound,
    setCustomDoneSound,
  };
}

interface AppPreferenceActionsOptions {
  setTerminalFontFamily: Dispatch<SetStateAction<string>>;
  setShowGitHubLink: (next: boolean) => void;
  setGithubLinks: Dispatch<SetStateAction<Record<string, GitHubLink | null>>>;
}

// Pass the GitHub setter here once useGitStatus has declared it in App.
export function useAppPreferenceActions({
  setTerminalFontFamily,
  setShowGitHubLink,
  setGithubLinks,
}: AppPreferenceActionsOptions) {
  // Most preferences now persist through usePersistentPreference's setter
  // directly; only ones with extra side effects keep a wrapper.
  const updateTerminalFontFamily = useCallback((next: string) => {
    setTerminalFontFamily(next);
    if (next.trim()) {
      localStorage.setItem(TERMINAL_FONT_FAMILY_STORAGE_KEY, next);
    } else {
      localStorage.removeItem(TERMINAL_FONT_FAMILY_STORAGE_KEY);
    }
  }, [setTerminalFontFamily]);

  const updateShowGitHubLink = useCallback(
    (next: boolean) => {
      setShowGitHubLink(next);
      if (!next) setGithubLinks({}); // drop resolved links once the chip is off
    },
    [setShowGitHubLink, setGithubLinks],
  );

  return { updateTerminalFontFamily, updateShowGitHubLink };
}
