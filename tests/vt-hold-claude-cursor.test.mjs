// Claude 2.1.286 paints its cursor as an inverse cell: on an empty, focused composer that cell is the
// placeholder's first character, not dim, and still no typed text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { closeVtPane, openVtPane, paneHold, writeVtPane } from "../dist-electron/vt-state.js";

// paneHold waits for xterm's write callback before reading; no parser sleep is needed.

const IDLE = readFileSync(new URL("./fixtures/claude-idle-composer.raw", import.meta.url), "utf8");
const REAL_ROW = "\x1b[7m \r";
assert.ok(IDLE.includes(REAL_ROW), "the capture's composer row moved: recapture the fixture");

const INV = (s) => `\x1b[7m${s}\x1b[27m`;
const DIM = (s) => `\x1b[2m${s}\x1b[22m`;
const withRow = (row) => IDLE.replace(REAL_ROW, `${row}\r`);

async function holdAfter(...streams) {
  openVtPane("cur", 120, 30, () => {}, "claude", false);
  try {
    let reason;
    for (const stream of streams) {
      writeVtPane("cur", stream);
      reason = await paneHold("cur");
    }
    return reason;
  } finally {
    closeVtPane("cur");
  }
}

const PLACEHOLDER = 'Try "write a test for <filepath>"';
const QUEUED = "Press up to edit queued messages";

// [name, streams in order, expected hold of the last (regexp) or null for free]
const TABLE = [
  ["the real idle composer (inverse blank cursor) is free", [IDLE], null],
  ["placeholder with the focused cursor on its first letter is free", [withRow(INV("T") + DIM(PLACEHOLDER.slice(1)))], null],
  ["placeholder of an unfocused pane (all dim) is free", [withRow(DIM(PLACEHOLDER))], null],
  ["the queued-messages hint with the cursor on its first letter is free", [withRow(INV("P") + DIM(QUEUED.slice(1)))], null],
  ["draft with the cursor after it holds", [withRow("half typed text" + INV(" "))], /typing/],
  ["draft with the cursor in the middle holds", [withRow("half " + INV("t") + "yped text")], /typing/],
  ["draft with the cursor on its first letter holds", [withRow(INV("h") + "alf typed text")], /typing/],
  ["a one-letter draft under the cursor holds", [withRow(INV("a"))], /typing/],
  ["a one-letter draft with the cursor after it holds", [withRow("a" + INV(" "))], /typing/],
  ["draft followed by dim text (a suggestion) holds: only an inverse head is the cursor", [withRow("half typed" + DIM(" ghost suggestion"))], /typing/],
  ["a one-letter draft followed by dim text holds", [withRow("a" + DIM(" ghost suggestion"))], /typing/],
  ["draft typed over the focused placeholder holds", [withRow(INV("T") + DIM(PLACEHOLDER.slice(1))), withRow("x" + INV(" "))], /typing/],
  ["draft erased back to the focused placeholder is free", [withRow("x" + INV(" ")), withRow(INV("T") + DIM(PLACEHOLDER.slice(1)))], null],
  ["draft erased back to the blank cursor is free", [withRow("x" + INV(" ")), IDLE], null],
];

for (const [name, streams, expected] of TABLE) {
  test(`claude cursor: ${name}`, async () => {
    const reason = await holdAfter(...streams);
    if (expected) assert.match(reason, expected);
    else assert.equal(reason, null);
  });
}
