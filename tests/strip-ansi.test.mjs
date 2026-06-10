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
