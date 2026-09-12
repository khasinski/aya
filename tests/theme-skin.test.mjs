// A semantic palette mapped to app-chrome CSS vars and terminal ThemeColors.
// Assertions are whole-object or value-equality: truthiness and loose
// /color-mix/ matches cannot see a dropped token or a misdirected fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paletteToChromeVars,
  paletteToThemeColors,
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

/** Every chrome token the skin owns. App.tsx sets and clears exactly these, so
 *  a token dropped here silently keeps its stylesheet value. */
const CHROME_KEYS = [
  "--bg",
  "--bg-secondary",
  "--bg-tertiary",
  "--bg-code",
  "--fg-primary",
  "--fg-secondary",
  "--fg-tertiary",
  "--fg-inverse",
  "--border",
  "--border-strong",
  "--border-focus",
  "--accent",
  "--accent-hover",
  "--heat-0",
  "--callout-info-bg",
  "--callout-info-fg",
  "--callout-warning-bg",
  "--callout-warning-fg",
  "--callout-success-bg",
  "--callout-success-fg",
  "--callout-error-bg",
  "--callout-error-fg",
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
  assert.equal(v["--fg-inverse"], "#1a1b26");
  assert.equal(v["--accent"], "#bb9af7");
  assert.equal(v["--border-focus"], "#bb9af7");
  assert.equal(v["--fg-tertiary"], "#414868"); // muted
  assert.equal(v["--border-strong"], "#414868"); // muted
  assert.equal(v["--callout-error-fg"], "#f7768e"); // red
  assert.equal(v["--callout-success-fg"], "#9ece6a"); // green
  assert.equal(v["--callout-warning-fg"], "#e0af68"); // yellow
  // The info pair reads ANSI blue, NOT the accent - hence the split fixture.
  assert.equal(v["--callout-info-fg"], "#7aa2f7");
  assert.equal(
    v["--callout-info-bg"],
    "color-mix(in oklab, #7aa2f7 15%, #1a1b26)",
  );
});

test("chrome tiers are derived by exact mixes, not merely 'some color-mix'", () => {
  const v = paletteToChromeVars(DARK);
  // Equality, not a substring: a wrong percentage or direction is still a
  // color-mix() and would pass a regex.
  assert.equal(v["--bg-secondary"], "color-mix(in oklab, #1a1b26 92%, #a9b1d6)");
  assert.equal(v["--bg-tertiary"], "color-mix(in oklab, #1a1b26 86%, #a9b1d6)");
  assert.equal(v["--bg-code"], "color-mix(in oklab, #1a1b26 90%, #a9b1d6)");
  assert.equal(v["--heat-0"], "color-mix(in oklab, #1a1b26 92%, #a9b1d6)");
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
  // Every ANSI-sourced callout falls back to the accent, not a literal.
  assert.equal(v["--callout-info-fg"], "#ff0000");
  assert.equal(v["--callout-warning-fg"], "#ff0000");
  assert.equal(v["--callout-success-fg"], "#ff0000");
  assert.equal(v["--callout-error-fg"], "#ff0000");
  assert.equal(
    v["--callout-error-bg"],
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
