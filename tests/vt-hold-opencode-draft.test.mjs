// OpenCode draws no chevron: its composer is a block of ┃ rows closed by a ╹ edge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, holdAfter } from "./helpers/vt-screens.mjs";
import { closeVtPane, openVtPane, paneHold, SCREEN_SETTLE_MS, writeVtPane } from "../dist-electron/vt-state.js";

const IDLE = fixture("opencode-idle.screen.txt");
const DRAFT = fixture("opencode-draft.screen.txt");
const PASTED = fixture("opencode-pasted.screen.txt");
const BUSY = fixture("busy-opencode.screen.txt");
const QUESTION = fixture("opencode-plan-question.screen.txt");
const bar = (text) => `             ┃  ${text}`.padEnd(100);
const TEXT_ROW = DRAFT.findIndex((row) => row.includes("half typed text"));
const MULTI = [...DRAFT.slice(0, TEXT_ROW + 1), bar("second line of the draft"), ...DRAFT.slice(TEXT_ROW + 1)];
const WITH_HISTORY = [bar("an earlier message the user sent"), bar(""), "     ▣  Build · Big Pickle", "", ...IDLE.slice(4)];
const withText = (text) => DRAFT.map((row) => (row.includes("half typed text") ? bar(text) : row));
const EDGE_ABOVE = [...IDLE.slice(0, 4), "             ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", ...IDLE.slice(4)];

// [name, screens in order, expected hold of the LAST one (a regexp), or null for free]
const OPENCODE = [
  ["the placeholder is not the user's text", [IDLE], null],
  ["half-typed text holds", [DRAFT], /typing/],
  ["a pasted-content placeholder is a draft", [PASTED], /typing/],
  ["a second line of the draft holds", [MULTI], /typing/],
  ["typed, then erased: free again", [DRAFT, IDLE], null],
  ["placeholder, then typed: held", [IDLE, DRAFT], /typing/],
  ["typed, then submitted and working: the composer is empty", [DRAFT, BUSY], null],
  ["an old message above the empty composer does not hold", [WITH_HISTORY], null],
  ["another block's closing edge right above the composer is not text", [EDGE_ABOVE], null],
  ["a draft and a question dialog: the dialog wins", [DRAFT, QUESTION], /prompt|approval|choice/],
  // The idle placeholder is `Ask anything… "<an example>"`; a draft that merely starts with those words is the user's.
  ["a draft that begins with the placeholder's words holds", [withText("Ask anything about the failing build")], /typing/],
  ["a draft of the placeholder's words plus an ellipsis and text holds", [withText("Ask anything... then rename it")], /typing/],
  ["a draft that quotes nothing after the words holds", [withText("Ask anything else")], /typing/],
  ["the placeholder with an ASCII ellipsis is not text", [withText('Ask anything... "Fix a TODO in the codebase"')], null],
  ["the placeholder clipped by a narrow pane is not text", [withText('Ask anything… "What is the te')], null],
  ["the placeholder clipped before its example is not text", [withText("Ask anything…")], null],
  ["typed after the placeholder was drawn: held", [IDLE, withText("Ask anything about the failing build")], /typing/],
  ["the bar rows alone, with no closing edge, claim no draft", [["  ┃", "  ┃  Ask anything…"]], null],
];
for (const [name, screens, want] of OPENCODE) {
  test(`opencode: ${name}`, async () => {
    const got = await holdAfter("opencode", screens);
    if (want === null) assert.equal(got, null, `paneHold said ${JSON.stringify(got)}`);
    else assert.match(String(got), want);
  });
}

// The bar block is OpenCode's: no other agent reads a draft from it.
test("unknown agent: no composer rule of ours, so no draft either", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  openVtPane("nd", 100, 30, () => {}, undefined, false);
  try {
    writeVtPane("nd", "\x1b[2J\x1b[H" + DRAFT.join("\r\n"));
    // paneHold drains xterm; only the quiet-screen age needs advancing.
    t.mock.timers.tick(SCREEN_SETTLE_MS + 150);
    assert.equal(await paneHold("nd"), null);
  } finally {
    closeVtPane("nd");
  }
});
