// OpenCode draws nothing for seconds after it starts (measured: blank at 2.5 s on a cold start); text typed
// then goes nowhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { closeVtPane, openVtPane, paneHold } from "../dist-electron/vt-state.js";
import { fixture, holdAfter } from "./helpers/vt-screens.mjs";

const IDLE = fixture("opencode-idle.screen.txt");
const BUSY = fixture("busy-opencode.screen.txt");
const QUESTION = fixture("opencode-plan-question.screen.txt");
const BLANK = [];
const LOGO_ONLY = IDLE.slice(0, 4);

// [name, screens in order, expected hold of the LAST one (a regexp), or null for free]
const OPENCODE = [
  ["nothing drawn yet", [BLANK], /starting up/],
  ["only the logo", [LOGO_ONLY], /starting up/],
  ["the composer is drawn", [IDLE], null],
  ["working: the composer stays on screen", [BUSY], null],
  ["a question dialog is a prompt, not a start", [QUESTION], /prompt|approval|choice/],
  ["drawn, then the screen is cleared: it is not starting again", [IDLE, BLANK], null],
  ["drawn, then it works, then a long answer scrolls the footer off", [IDLE, BUSY, ["long answer", "more answer"]], null],
  ["a small pane drops the footer: the bar rows alone are the composer", [["  ┃", "  ┃  Ask anything…"]], null],
  ["the closing edge alone is enough too", [["  ╹▀▀▀▀▀▀"]], null],
  ["a crash report before any UI is not a composer", [["error: something went wrong", "please file a GitHub issue"]], /starting up/],
  ["logo, then composer", [LOGO_ONLY, IDLE], null],
  ["composer, then back to a blank redraw of a resumed session before its footer", [BLANK, IDLE], null],
];
for (const [name, screens, want] of OPENCODE) {
  test(`opencode: ${name}`, async () => {
    const got = await holdAfter("opencode", screens);
    if (want === null) assert.equal(got, null, `paneHold said ${JSON.stringify(got)}`);
    else assert.match(String(got), want);
  });
}

// The footer wording belongs to OpenCode: another CLI quoting it is not drawn.
for (const agent of ["claude", "codex", "grok"]) {
  test(`${agent}: OpenCode's footer on screen does not mean ${agent} has drawn its composer`, async () => {
    assert.match(String(await holdAfter(agent, [IDLE])), /starting up/);
  });
}
// No agent and one named CLI without a composer rule stand for the rest.
for (const agent of [undefined, "kilo"]) {
  test(`${agent ?? "unknown agent"}: starting up right after its spawn, whatever is on screen (C13)`, async () => {
    assert.match(String(await holdAfter(agent, [BLANK])), /starting up/);
    assert.match(String(await holdAfter(agent, [IDLE])), /starting up/);
  });
}

test("a pane that exits before drawing is not running, not starting", async () => {
  openVtPane("ob2", 100, 30, () => {}, "opencode", false);
  closeVtPane("ob2");
  assert.match(String(await paneHold("ob2")), /not running/);
});
