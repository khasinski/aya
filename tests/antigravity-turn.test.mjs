// agy 1.2.14 takes a message only on its idle composer (a ">" row between two rules, then "? for shortcuts");
// any other screen is busy. Its turn is not recorded: "Generating..." (its documented busy rule) stands in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ownScreen } from "./helpers/own-screen.mjs";

const { openVtPane, closeVtPane, writeVtPane, paneHold } = await import("../dist-electron/vt-state.js");
const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { HOLD_BUSY, HOLD_DRAFT, HOLD_APPROVAL } = await import("../dist-electron/pane-holds.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEAR = "\x1b[2J\x1b[H";
// Row 9 (1-based) of the recorded idle screen is the empty "> " composer.
const typeInComposer = (text) => `\x1b[9;3H${text}`;
const TURN = `${CLEAR}  Antigravity CLI 1.2.14\r\n\r\n> fix the parser\r\n\r\n  ⠋ Generating...`;
const UNDER_COMPOSER = "\x1b[12;1H  ● Reading src/parser.ts";
const EMPTY_COMPOSER = "\x1b[9;3H\x1b[K";
const PALETTE = ownScreen("agy-palette").reads.map(([, text]) => text).join("");

let seq = 0;
async function agyPane() {
  const id = `agy-${(seq += 1)}`;
  const { meta, reads } = ownScreen("agy-idle");
  openVtPane(id, meta.cols, meta.rows, () => {}, "antigravity");
  for (const [, text] of reads) writeVtPane(id, text);
  assert.equal(await paneHold(id), null, "its idle composer is up and free");
  return id;
}

const SCREENS = [
  ["its idle composer", "", null],
  ["a draft in its composer", typeInComposer("half typed"), HOLD_DRAFT],
  ["a turn drawn under the composer", UNDER_COMPOSER, HOLD_BUSY],
  ["a turn that replaced the screen", TURN, HOLD_BUSY],
  ["its / palette", CLEAR + PALETTE, HOLD_APPROVAL],
];
for (const [name, draw, expected] of SCREENS) {
  test(`B-8 antigravity: ${name} -> ${expected ?? "free"}`, async () => {
    const id = await agyPane();
    try {
      if (draw) writeVtPane(id, draw);
      assert.equal(await paneHold(id), expected);
    } finally {
      closeVtPane(id);
    }
  });
}

const NOT_SEEN = "typed, not seen to start a turn";
const AFTER_ENTER = [
  ["a turn without the composer on screen (B-9)", TURN, null],
  ["the composer emptied", EMPTY_COMPOSER, null],
  ["nothing: the text stays in the composer", null, NOT_SEEN],
  ["its / palette comes up", CLEAR + PALETTE, /^typed, but a dialog came up after its Enter/],
];
for (const [name, afterEnter, expected] of AFTER_ENTER) {
  test(`B-9 antigravity: after Enter ${name}`, async () => {
    const id = await agyPane();
    let enters = 0;
    const write = async (_id, data) => {
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
      if (pasted) writeVtPane(id, typeInComposer(pasted[1]));
      else if (data === "\r") {
        enters += 1;
        if (afterEnter) writeVtPane(id, afterEnter);
      }
    };
    const probe = { hold: paneHold, outputMark: () => enters, outputPaused: () => true, windowMs: 600, sleep: () => sleep(50) };
    try {
      const unseen = await deliverTeamMessage(write, id, "Round 3: what is blocked?", (pane, p) => paneHold(pane, p), undefined, probe);
      assert.equal(enters, 1);
      if (expected instanceof RegExp) assert.match(unseen ?? "", expected);
      else assert.equal(unseen, expected);
    } finally {
      closeVtPane(id);
    }
  });
}
