// Parsing an Omarchy theme's colors.toml into the palette Aya skins from.
// Real dark (tokyo-night) and light (catppuccin-latte) samples, plus the mode
// precedence and the "not enough to skin from" guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOmarchyColors } from "../dist-electron/omarchy.js";

const TOKYO_NIGHT = `mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"

foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"

red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"

bright_red = "#ff7a93"
bright_green = "#b9f27c"
`;

const CATPPUCCIN_LATTE = `mode = "light"

accent = "#1e66f5"
background = "#eff1f5"
foreground = "#4c4f69"
red = "#d20f39"
green = "#40a02b"
`;

test("parses a full dark palette with all tiers and ANSI slots", () => {
  const p = parseOmarchyColors(TOKYO_NIGHT);
  assert.ok(p);
  assert.equal(p.mode, "dark");
  assert.equal(p.background, "#1a1b26");
  assert.equal(p.foreground, "#a9b1d6");
  assert.equal(p.accent, "#7aa2f7");
  assert.equal(p.lighterBackground, "#24283b");
  assert.equal(p.darkForeground, "#565f89");
  assert.equal(p.brightForeground, "#c0caf5");
  assert.equal(p.red, "#f7768e");
  assert.equal(p.brightRed, "#ff7a93");
});

test("parses a light palette and carries its mode", () => {
  const p = parseOmarchyColors(CATPPUCCIN_LATTE);
  assert.ok(p);
  assert.equal(p.mode, "light");
  assert.equal(p.accent, "#1e66f5");
});

test("mode falls back to the given default when the file names none", () => {
  const noMode = `background = "#111111"\nforeground = "#eeeeee"\naccent = "#ff0000"\n`;
  assert.equal(parseOmarchyColors(noMode).mode, "dark");
  assert.equal(parseOmarchyColors(noMode, "light").mode, "light");
});

test("the legacy theme_type key is honored when mode is absent", () => {
  const legacy = `theme_type = "light"\nbackground = "#fff"\nforeground = "#000"\naccent = "#f00"\n`;
  assert.equal(parseOmarchyColors(legacy).mode, "light");
});

test("comments and blank lines are ignored", () => {
  const withComments = `# a comment\n\nbackground = "#111"\n# another\nforeground = "#eee"\naccent = "#f00"\n`;
  const p = parseOmarchyColors(withComments);
  assert.ok(p);
  assert.equal(p.background, "#111");
});

test("a file missing background/foreground/accent is unusable (null)", () => {
  assert.equal(parseOmarchyColors(`accent = "#f00"\n`), null);
  assert.equal(parseOmarchyColors(""), null);
});
