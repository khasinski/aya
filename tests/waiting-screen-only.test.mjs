// A CLI dialog reaches the status dot only from the rendered screen, which raises and ends its waiting; only an
// agent's own question (`aya status waiting`) outlives the screen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPtyEvent } from "../dist-test/pty-event-reducer.js";

const pane = (overrides = {}) => ({ id: "t1", projectSlug: "demo", presetId: "claude", name: "t1", cwd: "/tmp", status: "running", bell: false, exitCode: null, ...overrides });
const ext = (level) => ({ externalStatus: { level, text: level, updatedAt: 1 } });
const QUESTION_TEXT = "⏺ I'm done. Do you want me to continue with titleCase?\n❯ ";
const data = (chunk) => ({ type: "data", ptyId: "t1", chunk });
const screen = (waiting) => ({ type: "vt-status", ptyId: "t1", waiting });

// [label, pane before, event, status after, bell after]
const ROWS = [
  ["working, prompt wording in the bytes", pane(), data(QUESTION_TEXT), "running", false],
  ["idle after a turn, prompt wording in the bytes", pane({ status: "idle" }), data(QUESTION_TEXT), "running", false],
  ["turn finished (hook), prompt wording in the bytes", pane({ status: "idle", ...ext("done") }), data(QUESTION_TEXT), "idle", false],
  ["running a tool (hook), prompt wording in the bytes", pane(ext("active")), data(QUESTION_TEXT), "running", false],
  ["working, the screen shows a dialog", pane(), screen(true), "waiting", true],
  ["turn finished (hook), the screen shows a dialog", pane({ status: "idle", ...ext("done") }), screen(true), "waiting", true],
  ["a dialog on screen, lots of output", pane({ status: "waiting", bell: true }), data("Compiling... ".repeat(20)), "waiting", true],
  ["a dialog on screen, the screen clears", pane({ status: "waiting", bell: true }), screen(false), "running", false],
  ["a dialog on screen over a running tool (hook), the screen clears", pane({ status: "waiting", bell: true, ...ext("active") }), screen(false), "running", false],
  ["a dialog on screen after a finished turn (hook), the screen clears", pane({ status: "waiting", bell: true, ...ext("done") }), screen(false), "idle", false],
  ["the agent asked the user, the screen clears", pane({ status: "waiting", bell: true, ...ext("waiting") }), screen(false), "waiting", true],
  ["the agent asked the user, output", pane({ status: "waiting", bell: true, ...ext("waiting") }), data("Compiling... ".repeat(20)), "waiting", true],
  ["turn finished (hook), the screen has nothing", pane({ status: "idle", ...ext("done") }), screen(false), "idle", false],
];

for (const [label, before, event, status, bell] of ROWS) {
  test(`one source for a dialog | ${label}`, () => {
    const next = applyPtyEvent({ t1: before }, event).t1;
    assert.equal(next.status, status);
    assert.equal(next.bell, bell);
    const dropped = label === "turn finished (hook), the screen shows a dialog";
    assert.deepEqual(next.externalStatus, dropped ? undefined : before.externalStatus, "the agent's own report stays, but a done from before a new dialog");
  });
}
