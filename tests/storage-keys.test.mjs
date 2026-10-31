// localStorage keys outlive a release: renaming one silently resets a user's
// preference, so every key is pinned to the string stored today.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as keys from "../dist-test/storage-keys.js";
import { GPU_RELAUNCHED_EVENT } from "../dist-test/window-events.js";

const EXPECTED = {
  APP_THEME_STORAGE_KEY: "aya:app-theme",
  MAC_OPTION_KEY_STORAGE_KEY: "aya:mac-option-key",
  TERMINAL_FONT_FAMILY_STORAGE_KEY: "aya:terminal-font-family",
  USAGE_HARNESS_NAME_STORAGE_KEY: "aya:usage-show-harness-name",
  STATUSBAR_GITHUB_LINK_STORAGE_KEY: "aya:statusbar-github-link",
  LAYOUT_MODE_STORAGE_KEY: "aya:layout-mode",
  WORKTREES_STORAGE_KEY: "aya:worktrees",
  HARNESS_SEARCH_STORAGE_KEY: "aya:harness-search",
  TERMINAL_SOUNDS_STORAGE_KEY: "aya:terminal-sounds",
  STATUS_RAIL_COLLAPSED_STORAGE_KEY: "aya:status-rail-collapsed",
  SOUND_OVERRIDES_STORAGE_KEY: "aya:terminal-sound-overrides",
  CUSTOM_WAITING_SOUND_STORAGE_KEY: "aya:terminal-sound-waiting",
  CUSTOM_DONE_SOUND_STORAGE_KEY: "aya:terminal-sound-done",
  LOCAL_SUMMARIES_STORAGE_KEY: "aya:local-summaries",
  LOCAL_SUMMARY_CACHE_STORAGE_KEY: "aya:local-summary-cache",
  AYA_INTELLIGENCE_STORAGE_KEY: "aya:intelligence",
  NO_HARNESS_HINT_DISMISSED_STORAGE_KEY: "aya:no-harness-hint-dismissed",
  DEBUG_TERMINAL_INPUT_STORAGE_KEY: "aya:debug-terminal-input",
};

test("every stored preference keeps the key it is stored under today", () => {
  const constants = Object.fromEntries(Object.entries(keys).filter(([, v]) => typeof v === "string"));
  assert.deepEqual(constants, EXPECTED);
});

test("an ignored repo config is remembered per project directory", () => {
  assert.equal(keys.repoConfigIgnoredKey("/Users/me/app"), "aya:repo-config-ignored:/Users/me/app");
});

test("the GPU relaunch window event keeps its name", () => {
  assert.equal(GPU_RELAUNCHED_EVENT, "aya:gpu-relaunched");
});
