// Parsing an Omarchy theme's colors.toml into the palette Aya skins from.
// Real dark (tokyo-night) and light (catppuccin-latte) samples, the mode
// precedence, the "not enough to skin from" guard, and the value-shape rules -
// because BOTH sinks downstream (CSSOM setProperty for the chrome vars, xterm's
// own color parser for the terminal) discard an unparsable color in silence.
// Anything this parser lets through unchecked disappears without a trace.

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
  // The WHOLE palette, not spot checks: every optional field here has a `??`
  // fallback in src/theme-skin.ts, so a key silently dropped from FIELD_MAP
  // yields a plausible-looking color rather than a visible failure. A strict
  // deep-equal also catches a key renamed or added.
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
  // Passing the OPPOSITE fallback is what makes this falsifiable: asserting
  // "dark" while the default fallback is also "dark" passes even when the mode
  // key is never read at all.
  assert.equal(parseOmarchyColors(TOKYO_NIGHT, "light").mode, "dark");
  assert.equal(parseOmarchyColors(CATPPUCCIN_LATTE, "dark").mode, "light");
});

test("parses a light palette and carries its mode", () => {
  const p = parseOmarchyColors(CATPPUCCIN_LATTE);
  assert.equal(p.mode, "light");
  assert.equal(p.accent, "#1e66f5");
  // The light fixture's own ANSI keys, so FIELD_MAP is exercised on this path
  // too rather than only on the dark one.
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

// The comment case that is actually load-bearing. A full-line "#" comment is
// already rejected by the key regex, so a fixture built only from those cannot
// distinguish guard-present from guard-absent - it is a tautology. A TRAILING
// comment is different: it used to defeat the starts-and-ends-with-a-quote test
// and yield the literal `"#f00" # my accent`, which both sinks then threw away
// while Settings still claimed the theme was being followed.
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
  // Reading a sectioned file flat would let `[bright] red` win by last-key-wins
  // and hand the terminal the wrong red, with nothing to signal it.
  const p = parseOmarchyColors(
    toml(BG, FG, AC, 'red = "#ff0000"', "[bright]", 'red = "#00ff00"'),
  );
  assert.equal(p.red, "#ff0000");
});

// The test above uses `[bright]`, which is not a palette table at all, so it
// cannot tell top-level PRECEDENCE from mere table-filtering: both readings
// agree there. Measured: flipping the lookup to prefer tables left it green.
test("a top-level key beats the same key under a palette table", () => {
  const p = parseOmarchyColors(
    toml(BG, FG, AC, 'red = "#ff0000"', "[colors]", 'red = "#00ff00"'),
  );
  assert.equal(p.red, "#ff0000", "the top-level value is the declared one");
});

// Two palette tables offering the same key: the first one read wins, so adding
// a table lower in the file cannot silently restyle a key already resolved
// above it. Measured: without this, dropping the first-wins guard stayed green.
test("when two palette tables offer a key, the first one read wins", () => {
  const p = parseOmarchyColors(
    toml(BG, FG, AC, "[colors]", 'red = "#ff0000"', "[palette]", 'red = "#00ff00"'),
  );
  assert.equal(p.red, "#ff0000");
});

test("essentials living under a table are still resolved", () => {
  // A latch that simply dropped everything after the first header would reject
  // this file outright - a regression against the pre-existing flat parser,
  // which would have picked these keys up.
  const p = parseOmarchyColors(
    toml('mode = "dark"', "[primary]", BG, FG, AC, "[normal]", 'red = "#ff0000"'),
  );
  assert.ok(p, "a sectioned palette must not be rejected");
  assert.equal(p.background, "#111");
  assert.equal(p.accent, "#f00");
  assert.equal(p.red, "#ff0000");
});

test("a DOTTED table header resolves like a plain one", () => {
  // `[colors.primary]` is the canonical Alacritty spelling, and the old flat
  // parser resolved such a file. Matching the whole table path against the
  // nested-section list instead of its last segment would reject it - Omarchy
  // silently reported unavailable and the skin dropped app-wide.
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
  // The whole point of namespacing: an unrelated table must not stand in for
  // the palette. `[ui.chrome]` is neither top level nor a known palette table.
  assert.equal(
    parseOmarchyColors(toml("[ui.chrome]", BG, FG, AC)),
    null,
  );
});

test("a sectioned file's own mode is honored, not just its colors", () => {
  // The namespacing has to apply to `mode` too: a sectioned file is precisely
  // the shape it exists for, and reading mode only at the top level would make
  // such a theme silently fall back to the caller's default - a light Omarchy
  // theme rendering as dark.
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
  // /#[0-9a-f]{3,8}/ but resolves nowhere: xterm switches on those exact
  // lengths and CSSOM drops the declaration - the silent discard this gate
  // exists to stop.
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = "#12345"')), null);
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = "#1234567"')), null);
  assert.ok(parseOmarchyColors(toml(BG, FG, 'accent = "#1234"')), "4-digit hex is legal");
  assert.ok(
    parseOmarchyColors(toml(BG, FG, 'accent = "#11223344"')),
    "8-digit hex is legal",
  );
});

test("an arbitrary word is not treated as a color", () => {
  // "mauve", "notacolor", "currentColor" all match /[a-zA-Z]+/ and none of them
  // resolves in either sink.
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
  // Reporting "available" for a file we cannot skin from is what let Settings
  // offer - and claim - a theme that neither sink would apply.
  assert.equal(parseOmarchyColors(toml(BG, FG, 'accent = "rgb(1,2"')), null);
});

// One fixture per clause, so each half of the guard is individually
// falsifiable: a fixture that omits two fields at once only proves that SOME
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

test("a file with nothing in it is unusable (null)", () => {
  assert.equal(parseOmarchyColors(""), null);
});
