// Parsing an Omarchy theme's colors.toml into the palette Aya skins from.
// Value-shape rules matter because both sinks (CSSOM setProperty, xterm's color
// parser) discard an unparsable color in silence.

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

/** Build a colors.toml from lines, so fixtures stay readable. */
const toml = (...lines) => lines.join("\n") + "\n";
const BG = 'background = "#111"';
const FG = 'foreground = "#eee"';
const AC = 'accent = "#f00"';

test("parses a full dark palette with all tiers and ANSI slots", () => {
  // The WHOLE palette: every optional field has a `??` fallback in
  // theme-skin.ts, so a key dropped from FIELD_MAP yields a plausible color.
  assert.deepStrictEqual(parseOmarchyColors(TOKYO_NIGHT), {
    mode: "dark",
    accent: "#7aa2f7",
    selection: "#292e42",
    muted: "#414868",
    background: "#1a1b26",
    darkBackground: "#13141c",
    darkerBackground: "#0e0e14",
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
    brightGreen: "#b9f27c",
  });
});

test("the file's own mode wins over the caller's fallback", () => {
  // The OPPOSITE fallback makes this falsifiable: asserting "dark" against a
  // "dark" default passes even when the mode key is never read.
  assert.equal(parseOmarchyColors(TOKYO_NIGHT, "light").mode, "dark");
  assert.equal(parseOmarchyColors(CATPPUCCIN_LATTE, "dark").mode, "light");
});

test("parses a light palette and carries its mode", () => {
  const p = parseOmarchyColors(CATPPUCCIN_LATTE);
  assert.equal(p.mode, "light");
  assert.equal(p.accent, "#1e66f5");
  // The light fixture's own ANSI keys, so FIELD_MAP is exercised here too.
  assert.equal(p.red, "#d20f39");
  assert.equal(p.green, "#40a02b");
});

test("mode falls back to the given default when the file names none", () => {
  const noMode = toml(BG, FG, AC);
  assert.equal(parseOmarchyColors(noMode).mode, "dark");
  assert.equal(parseOmarchyColors(noMode, "light").mode, "light");
});

test("the legacy theme_type key is honored when mode is absent", () => {
  assert.equal(
    parseOmarchyColors(toml('theme_type = "light"', BG, FG, AC)).mode,
    "light",
  );
});

// A full-line "#" comment is already rejected by the key regex, so it cannot
// tell guard-present from guard-absent. A TRAILING comment used to defeat the
// quote test and yield the literal `"#f00" # my accent`, silently discarded.
test("a trailing comment is stripped, not carried into the color", () => {
  const p = parseOmarchyColors(toml(BG, FG, 'accent = "#f00" # my accent'));
  assert.equal(p.accent, "#f00");
});

test("an unquoted value keeps its leading # but loses a trailing comment", () => {
  const p = parseOmarchyColors(
    toml("background = #111", "foreground = #eee", "accent = #f00  # brand"),
  );
  assert.equal(p.background, "#111");
  assert.equal(p.accent, "#f00");
});

test("keys under a [section] do not overwrite the top-level palette", () => {
  // Read flat, `[bright] red` would win by last-key-wins and reach the terminal.
  const p = parseOmarchyColors(
    toml(BG, FG, AC, 'red = "#ff0000"', "[bright]", 'red = "#00ff00"'),
  );
  assert.equal(p.red, "#ff0000");
});

// `[bright]` above is not a palette table, so it cannot tell PRECEDENCE from
// table-filtering. Measured: flipping the lookup to prefer tables left it green.
test("a top-level key beats the same key under a palette table", () => {
  const p = parseOmarchyColors(
    toml(BG, FG, AC, 'red = "#ff0000"', "[colors]", 'red = "#00ff00"'),
  );
  assert.equal(p.red, "#ff0000", "the top-level value is the declared one");
});

// First table read wins, so a later table cannot restyle a resolved key.
// Measured: without this, dropping the first-wins guard stayed green.
test("when two palette tables offer a key, the first one read wins", () => {
  const p = parseOmarchyColors(
    toml(BG, FG, AC, "[colors]", 'red = "#ff0000"', "[palette]", 'red = "#00ff00"'),
  );
  assert.equal(p.red, "#ff0000");
});

test("essentials living under a table are still resolved", () => {
  // Dropping everything after the first header would reject this file - a
  // regression against the old flat parser, which resolved these keys.
  const p = parseOmarchyColors(
    toml('mode = "dark"', "[primary]", BG, FG, AC, "[normal]", 'red = "#ff0000"'),
  );
  assert.ok(p, "a sectioned palette must not be rejected");
  assert.equal(p.background, "#111");
  assert.equal(p.accent, "#f00");
  assert.equal(p.red, "#ff0000");
});

test("a DOTTED table header resolves like a plain one", () => {
  // `[colors.primary]` is the canonical Alacritty spelling. Matching the whole
  // path instead of its last segment rejected it and dropped the skin app-wide.
  const p = parseOmarchyColors(
    toml("[colors.primary]", BG, FG, AC, "[colors.normal]", 'red = "#ff0000"'),
  );
  assert.ok(p, "a dotted-table palette must not be rejected");
  assert.equal(p.background, "#111");
  assert.equal(p.foreground, "#eee");
  assert.equal(p.accent, "#f00");
  assert.equal(p.red, "#ff0000");
});

test("a dotted table that is NOT a palette table cannot supply essentials", () => {
  // `[ui.chrome]` is neither top level nor a known palette table.
  assert.equal(
    parseOmarchyColors(toml("[ui.chrome]", BG, FG, AC)),
    null,
  );
});

test("a sectioned file's own mode is honored, not just its colors", () => {
  // Reading mode only at the top level makes a sectioned file fall back to the
  // caller's default - a light Omarchy theme rendering as dark.
  const p = parseOmarchyColors(
    toml("[primary]", 'mode = "light"', BG, FG, AC),
    "dark",
  );
  assert.equal(p.mode, "light");
});

test("a value that is not a color is dropped rather than passed on", () => {
  const p = parseOmarchyColors(toml(BG, FG, AC, 'red = "not a color!"'));
  assert.equal(p.red, undefined);
});

test("hex-ish values of an illegal length are rejected", () => {
  // CSS hex is 3, 4, 6 or 8 digits. A 5- or 7-digit value passes a naive
  // /#[0-9a-f]{3,8}/ but resolves in neither sink.
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = "#12345"')), null);
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = "#1234567"')), null);
  assert.ok(parseOmarchyColors(toml(BG, FG, 'accent = "#1234"')), "4-digit hex is legal");
  assert.ok(
    parseOmarchyColors(toml(BG, FG, 'accent = "#11223344"')),
    "8-digit hex is legal",
  );
});

test("an arbitrary word is not treated as a color", () => {
  // All match /[a-zA-Z]+/ and none resolves in either sink.
  for (const word of ["mauve", "notacolor", "currentColor", "transparent"]) {
    assert.equal(
      parseOmarchyColors(toml(BG, FG, `accent = "${word}"`)),
      null,
      `${word} must not pass as a color`,
    );
  }
});

test("functional color notations and real CSS keywords are accepted", () => {
  const p = parseOmarchyColors(
    toml(BG, FG, AC, 'red = "rgb(255, 0, 0)"', 'green = "rebeccapurple"'),
  );
  assert.equal(p.red, "rgb(255, 0, 0)");
  assert.equal(p.green, "rebeccapurple");
});

test("an essential that is not a color makes the file unusable (null)", () => {
  // Reporting "available" let Settings offer a theme neither sink would apply.
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = "rgb(1,2"')), null);
});

// One fixture per clause: omitting two fields at once proves only that SOME
// emptiness check exists, not which fields it covers.
test("each of background/foreground/accent is individually required", () => {
  assert.equal(parseOmarchyColors(toml(FG, AC)), null, "background missing");
  assert.equal(parseOmarchyColors(toml(BG, AC)), null, "foreground missing");
  assert.equal(parseOmarchyColors(toml(BG, FG)), null, "accent missing");
  assert.ok(parseOmarchyColors(toml(BG, FG, AC)), "all three present");
});

test("an empty value is as unusable as a missing one", () => {
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = ""')), null);
});

// The test above has no table to fall through TO, so it passes either way.
// Measured: `??` instead of `||` in the lookup returns null here.
test("an empty top-level value falls through to a palette table", () => {
  const p = parseOmarchyColors(
    toml(BG, FG, 'accent = ""', "[colors]", 'accent = "#f00"'),
  );
  assert.equal(p.accent, "#f00");
});

test("a file with nothing in it is unusable (null)", () => {
  assert.equal(parseOmarchyColors(""), null);
});
