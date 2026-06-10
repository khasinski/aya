// Verifies stripAnsi (cleans search snippets). It must strip OSC sequences
// terminated by ST (ESC \) as well as by BEL — matching only BEL leaked the
// title payload of ST-terminated sequences into snippets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../dist-electron/pty.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

test("strips a BEL-terminated OSC title sequence completely", () => {
  const out = stripAnsi(`before${ESC}]0;my title${BEL}after`);
  assert.equal(out, "beforeafter");
});

test("strips CSI color sequences", () => {
  const out = stripAnsi(`${ESC}[1;31mRED${ESC}[0m`);
  assert.equal(out, "RED");
});

test("strips an ST-terminated OSC title sequence completely (no payload leak)", () => {
  const out = stripAnsi(`before${ESC}]0;my title${ST}after`);
  assert.equal(out, "beforeafter");
});

// Regression guard (grok review): a DCS string whose payload contains an OSC
// start must be stripped whole. With OSC handled before DCS, the OSC rule stole
// the DCS string's ST terminator and orphaned its introducer ("Pdcsdata after").
// DCS is now stripped first.
test("strips a DCS string whose payload contains an OSC start (no orphaned introducer)", () => {
  const out = stripAnsi(`${ESC}Pdcsdata ${ESC}]0;t${ST}after`);
  assert.equal(out, "after");
});

test("strips a multi-line OSC payload (clipboard-style) across newlines", () => {
  const out = stripAnsi(`a${ESC}]52;c;line1\nline2${BEL}b`);
  assert.equal(out, "ab");
});
