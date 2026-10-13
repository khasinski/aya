// A semantic palette mapped to app-chrome CSS vars and terminal ThemeColors.
// Assertions are whole-object or value-equality: truthiness and loose
// /color-mix/ matches cannot see a dropped token or a misdirected fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paletteToChromeVars,
  paletteToThemeColors,
  resolveActiveTheme,
  resolveActiveThemeId,
  sweepPresetThemes,
} from "../dist-test/theme-skin.js";

// `accent` is deliberately DIFFERENT from `blue`: sharing a value makes the
// `p.blue ?? accent` fallbacks indistinguishable.
const DARK = {
  mode: "dark",
  accent: "#bb9af7",
  selection: "#292e42",
  muted: "#414868",
  background: "#1a1b26",
  // darkerBackground absent on purpose: ANSI black exercises the second link of
  // its chain (darker -> dark -> background), distinct from the background.
  darkBackground: "#13141c",
  lighterBackground: "#24283b",
  foreground: "#a9b1d6",
  darkForeground: "#565f89",
  lightForeground: "#b4bee6",
  brightForeground: "#c0caf5",
  red: "#f7768e",
  yellow: "#e0af68",
  green: "#9ece6a",
  cyan: "#449dab",
  blue: "#7aa2f7",
  magenta: "#ad8ee6",
  brightRed: "#ff7a93",
};

/** Every chrome token the skin owns. useAppTheme sets and clears exactly these, so
 *  a token dropped here silently keeps its stylesheet value. */
const CHROME_KEYS = [
  "--bg",
  "--bg-secondary",
  "--bg-tertiary",
  "--bg-code",
  "--fg-primary",
  "--fg-secondary",
  "--fg-tertiary",
  "--border",
  "--border-strong",
  "--accent",
  "--accent-hover",
  "--callout-warning-bg",
  "--callout-warning-fg",
];

test("the chrome token set is exactly what the renderer applies", () => {
  assert.deepEqual(
    Object.keys(paletteToChromeVars(DARK)).sort(),
    [...CHROME_KEYS].sort(),
  );
});

test("chrome vars map the palette's own colors onto Aya's source tokens", () => {
  const v = paletteToChromeVars(DARK);
  assert.equal(v["--bg"], "#1a1b26");
  assert.equal(v["--fg-primary"], "#a9b1d6");
  assert.equal(v["--accent"], "#bb9af7");
  assert.equal(v["--fg-tertiary"], "#414868"); // muted
  assert.equal(v["--border-strong"], "#414868"); // muted
  // The warning pair reads ANSI yellow, NOT the accent - hence the fixture
  // keeps them distinct.
  assert.equal(v["--callout-warning-fg"], "#e0af68"); // yellow
  assert.equal(
    v["--callout-warning-bg"],
    "color-mix(in oklab, #e0af68 15%, #1a1b26)",
  );
});

test("chrome tiers are derived by exact mixes, not merely 'some color-mix'", () => {
  const v = paletteToChromeVars(DARK);
  // Equality, not a substring: a wrong percentage or direction is still a
  // color-mix() and would pass a regex.
  assert.equal(v["--bg-secondary"], "color-mix(in oklab, #1a1b26 92%, #a9b1d6)");
  assert.equal(v["--bg-tertiary"], "color-mix(in oklab, #1a1b26 86%, #a9b1d6)");
  assert.equal(v["--bg-code"], "color-mix(in oklab, #1a1b26 90%, #a9b1d6)");
  assert.equal(v["--fg-secondary"], "color-mix(in oklab, #a9b1d6 82%, #1a1b26)");
  assert.equal(v["--border"], "color-mix(in oklab, #1a1b26 62%, #414868)");
  assert.equal(v["--accent-hover"], "color-mix(in oklab, #bb9af7 82%, #a9b1d6)");
});

test("a partial palette still yields every chrome token, with the right fallbacks", () => {
  const v = paletteToChromeVars({
    mode: "dark",
    accent: "#ff0000",
    background: "#000000",
    foreground: "#ffffff",
  });
  assert.deepEqual(Object.keys(v).sort(), [...CHROME_KEYS].sort());
  // muted absent -> derived from fg/bg at a SPECIFIC ratio.
  assert.equal(v["--fg-tertiary"], "color-mix(in oklab, #ffffff 55%, #000000)");
  assert.equal(v["--border-strong"], "color-mix(in oklab, #ffffff 55%, #000000)");
  // The ANSI-sourced callout falls back to the accent, not a literal.
  assert.equal(v["--callout-warning-fg"], "#ff0000");
  assert.equal(
    v["--callout-warning-bg"],
    "color-mix(in oklab, #ff0000 15%, #000000)",
  );
});

/** Every slot xterm reads from us. A slot that goes missing - or turns
 *  conditional - silently hands that color back to xterm's own defaults. */
const TERMINAL_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

test("terminal colors are concrete hex straight from the palette", () => {
  // The previous guard - no value matches /color-mix/ - was vacuous and left 14
  // of the 21 slots undefended: green and cyan could be swapped, still green.
  assert.deepStrictEqual(paletteToThemeColors(DARK), {
    background: "#1a1b26",
    foreground: "#a9b1d6",
    cursor: "#bb9af7",
    cursorAccent: "#1a1b26",
    selectionBackground: "#292e42",
    black: "#13141c", // no darker_background -> dark_background
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#ad8ee6",
    cyan: "#449dab",
    white: "#b4bee6",
    brightBlack: "#414868",
    brightRed: "#ff7a93",
    brightGreen: "#9ece6a", // no bright_green -> base green
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#ad8ee6",
    brightCyan: "#449dab",
    brightWhite: "#c0caf5",
  });
});

test("a minimal palette fills every terminal slot from bg/fg/accent", () => {
  // Nothing may be undefined: xterm falls back to ITS defaults, which is how a
  // light theme ends up with a black terminal.
  const c = paletteToThemeColors({
    mode: "light",
    accent: "#1e66f5",
    background: "#eff1f5",
    foreground: "#4c4f69",
  });
  // The key SET, not a per-entry loop: Object.entries skips a missing key, so a
  // slot made conditional walks straight past a typeof/length check.
  assert.deepEqual(Object.keys(c).sort(), [...TERMINAL_KEYS].sort());
  // Whole-object, so the literal fallbacks are pinned and cannot be swapped.
  // Note: on this LIGHT palette black and selectionBackground both land on the
  // background, and the ANSI literals are dark - that is today's behavior.
  assert.deepStrictEqual(c, {
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#1e66f5",
    cursorAccent: "#eff1f5",
    selectionBackground: "#eff1f5",
    black: "#eff1f5", // no dark backgrounds -> the background
    red: "#cc6666",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#1e66f5", // no ANSI blue -> the accent
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#4c4f69", // no light foreground -> the foreground
    brightBlack: "#4c4f69",
    brightRed: "#cc6666",
    brightGreen: "#b5bd68",
    brightYellow: "#f0c674",
    brightBlue: "#1e66f5",
    brightMagenta: "#b294bb",
    brightCyan: "#8abeb7",
    brightWhite: "#4c4f69",
  });
  // No color-mix can reach the terminal: xterm cannot parse it.
  for (const value of Object.values(c)) {
    assert.doesNotMatch(value, /color-mix/);
  }
});

const FIRST_THEME = {
  id: "first",
  name: "First",
  colors: paletteToThemeColors(DARK),
};
const SECOND_THEME = {
  id: "second",
  name: "Second",
  colors: { ...FIRST_THEME.colors, background: "#ffffff" },
};

test("active theme resolution selects the matching theme and keeps its colors object", () => {
  const { activeTheme, activeThemeColors } = resolveActiveTheme(
    [FIRST_THEME, SECOND_THEME],
    "second",
  );
  assert.equal(activeTheme, SECOND_THEME);
  assert.equal(activeThemeColors, SECOND_THEME.colors);
});

test("missing and empty active ids fall back to the first theme in list order", () => {
  for (const activeId of ["missing", ""]) {
    const { activeTheme, activeThemeColors } = resolveActiveTheme(
      [SECOND_THEME, FIRST_THEME],
      activeId,
    );
    assert.equal(activeTheme, SECOND_THEME);
    assert.equal(activeThemeColors, SECOND_THEME.colors);
  }
});

test("duplicate theme ids resolve to the first matching theme", () => {
  const duplicate = { ...SECOND_THEME, id: FIRST_THEME.id };
  const { activeTheme, activeThemeColors } = resolveActiveTheme(
    [FIRST_THEME, duplicate],
    FIRST_THEME.id,
  );
  assert.equal(activeTheme, FIRST_THEME);
  assert.equal(activeThemeColors, FIRST_THEME.colors);
});

test("an empty theme list uses the complete Aya Dark fallback with stable identity", () => {
  const { activeTheme, activeThemeColors } = resolveActiveTheme([], "missing");
  assert.equal(activeTheme, undefined);
  assert.deepEqual(activeThemeColors, {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#c9d1d9",
    cursorAccent: "#0d1117",
    selectionBackground: "rgba(88,166,255,0.3)",
    black: "#484f58",
    red: "#ff7b72",
    green: "#56d364",
    yellow: "#e3b341",
    blue: "#79c0ff",
    magenta: "#d2a8ff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#7ee787",
    brightYellow: "#f0ad4e",
    brightBlue: "#a5d6ff",
    brightMagenta: "#ffa657",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  });
  assert.equal(resolveActiveTheme([], "").activeThemeColors, activeThemeColors);
});

test("saving themes retains a live active id or uses the first id, then the empty id", () => {
  assert.equal(resolveActiveThemeId([FIRST_THEME, SECOND_THEME], "second"), "second");
  assert.equal(resolveActiveThemeId([SECOND_THEME, FIRST_THEME], "missing"), "second");
  assert.equal(resolveActiveThemeId([FIRST_THEME], ""), "first");
  assert.equal(resolveActiveThemeId([], "second"), "");
  assert.equal(resolveActiveThemeId([], ""), "");
});

test("theme sweep drops only dangling references, preserving preset order and other fields", () => {
  const live = { id: "live", name: "Live", command: "shell", themeId: "first" };
  const dangling = {
    id: "dangling",
    name: "Dangling",
    command: "claude",
    themeId: "removed",
    env: { EXAMPLE: "kept" },
  };
  const unthemed = { id: "plain", name: "Plain", command: "codex" };
  const current = [live, dangling, unthemed];
  const { swept, dirty } = sweepPresetThemes(current, [FIRST_THEME]);
  assert.equal(dirty, true);
  assert.deepEqual(swept, [
    live,
    { id: "dangling", name: "Dangling", command: "claude", env: dangling.env },
    unthemed,
  ]);
  assert.equal(Object.hasOwn(swept[1], "themeId"), false);
  assert.equal(swept[0], live);
  assert.equal(swept[2], unthemed);
  assert.equal(swept[1].env, dangling.env);
  assert.notEqual(swept[1], dangling);
  assert.equal(dangling.themeId, "removed");
  assert.deepEqual(current, [live, dangling, unthemed]);
});

test("a sweep with no dangling references stays clean and retains every preset object", () => {
  const current = [
    { id: "live", name: "Live", command: "shell", themeId: "first" },
    { id: "plain", name: "Plain", command: "codex" },
    { id: "empty", name: "Empty", command: "claude", themeId: "" },
  ];
  const { swept, dirty } = sweepPresetThemes(current, [FIRST_THEME]);
  assert.equal(dirty, false);
  assert.deepEqual(swept, current);
  assert.notEqual(swept, current);
  for (let i = 0; i < current.length; i += 1) assert.equal(swept[i], current[i]);
  assert.deepEqual(sweepPresetThemes([], [FIRST_THEME]), { swept: [], dirty: false });
});

test("removing every theme sweeps every non-empty theme reference", () => {
  const empty = { id: "empty", name: "Empty", command: "shell", themeId: "" };
  const { swept, dirty } = sweepPresetThemes([
    { id: "first", name: "First", command: "claude", themeId: "first" },
    { id: "second", name: "Second", command: "codex", themeId: "second" },
    empty,
  ], []);
  assert.equal(dirty, true);
  assert.deepEqual(swept, [
    { id: "first", name: "First", command: "claude" },
    { id: "second", name: "Second", command: "codex" },
    empty,
  ]);
  assert.equal(swept[2], empty);
});
