// The one mapping that turns a semantic palette into the whole app's look:
// app-chrome CSS vars and terminal ThemeColors. These pin the contract the
// renderer relies on (which tokens exist, that ANSI slots come straight from
// the palette, and that chrome tiers are derived so a partial palette still
// yields a full set).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paletteToChromeVars,
  paletteToThemeColors,
} from "../dist-test/theme-skin.js";

const DARK = {
  mode: "dark",
  accent: "#7aa2f7",
  selection: "#292e42",
  muted: "#414868",
  background: "#1a1b26",
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

test("chrome vars map the palette's own colors onto Aya's source tokens", () => {
  const v = paletteToChromeVars(DARK);
  assert.equal(v["--bg"], "#1a1b26");
  assert.equal(v["--fg-primary"], "#a9b1d6");
  assert.equal(v["--accent"], "#7aa2f7");
  assert.equal(v["--border-focus"], "#7aa2f7");
  assert.equal(v["--fg-tertiary"], "#414868"); // muted
  assert.equal(v["--callout-error-fg"], "#f7768e"); // red
});

test("chrome tiers are derived (color-mix) so they always exist", () => {
  const v = paletteToChromeVars(DARK);
  // secondary/tertiary/code are mixes toward the foreground, not raw palette.
  assert.match(v["--bg-secondary"], /color-mix\(in oklab, #1a1b26 92%, #a9b1d6\)/);
  assert.match(v["--accent-hover"], /color-mix\(in oklab, #7aa2f7 82%, #a9b1d6\)/);
  // callout backgrounds are a faint tint of the ANSI color over the bg.
  assert.match(v["--callout-info-bg"], /color-mix\(in oklab, #7aa2f7 15%, #1a1b26\)/);
});

test("a partial palette (only bg/fg/accent) still yields every chrome token", () => {
  const v = paletteToChromeVars({
    mode: "dark",
    accent: "#ff0000",
    background: "#000000",
    foreground: "#ffffff",
  });
  for (const key of [
    "--bg",
    "--bg-secondary",
    "--fg-primary",
    "--fg-tertiary",
    "--border",
    "--accent",
    "--callout-success-fg",
  ]) {
    assert.ok(v[key], `${key} must be present`);
  }
  // muted absent -> derived from fg/bg, not undefined.
  assert.match(v["--fg-tertiary"], /color-mix/);
});

test("terminal colors are concrete hex straight from the palette", () => {
  const c = paletteToThemeColors(DARK);
  assert.equal(c.background, "#1a1b26");
  assert.equal(c.foreground, "#a9b1d6");
  assert.equal(c.red, "#f7768e");
  assert.equal(c.brightRed, "#ff7a93");
  assert.equal(c.selectionBackground, "#292e42");
  assert.equal(c.white, "#b4bee6"); // light_foreground
  assert.equal(c.brightWhite, "#c0caf5"); // bright_foreground
  // No color-mix leaks into terminal colors (xterm can't parse it).
  for (const value of Object.values(c)) {
    assert.doesNotMatch(String(value), /color-mix/);
  }
});

test("terminal bright slots fall back to their base ANSI color when absent", () => {
  const c = paletteToThemeColors(DARK);
  // brightGreen not in DARK -> falls back to green.
  assert.equal(c.brightGreen, "#9ece6a");
});
