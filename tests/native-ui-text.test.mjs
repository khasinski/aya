// main.ts's native windows that quote tab and project names: the waiting-for-input notification and the yes/no before
// a restart that stops background work. Those names come from config files an agent can write too, so they are shown
// as text: each acting character as its escape, the rest as is.

import { test } from "node:test";
import assert from "node:assert/strict";

const { quietWhenTesting, restartDialog, waitingNotification } = await import("../dist-electron/native-ui-text.js");

const RLO = String.fromCharCode(0x202e);
const U = (hex) => `\\u${hex}`;

test("the waiting notification shows a hostile tab name as text", () => {
  assert.deepEqual(waitingNotification(`worker${RLO}TXT in game\x1b]0;x\x07`), {
    title: "Aya - waiting for input",
    body: `worker${U("202e")}TXT in game${U("001b")}]0;x${U("0007")}`,
    silent: true,
  });
});

test("the restart dialog shows its button and its list as text, with Cancel the default", () => {
  const options = restartDialog(`Restart ${RLO}tset`, `pane w\x1b[2J: a dev server\nother: a watcher`);
  assert.deepEqual(options.buttons, [`Restart ${U("202e")}tset`, "Cancel"]);
  assert.equal(options.detail, `pane w${U("001b")}[2J: a dev server\nother: a watcher`);
  assert.deepEqual([options.defaultId, options.cancelId, options.message], [1, 1, "Work in progress will stop"]);
});

test("a hidden test run's notifications are silent, a normal run's are left as they were", () => {
  assert.equal(quietWhenTesting({ title: "t", silent: false }, true).silent, true);
  assert.deepEqual(quietWhenTesting({ title: "t", silent: false }, false), { title: "t", silent: false });
  const original = { title: "t", silent: false };
  quietWhenTesting(original, true);
  assert.equal(original.silent, false, "the caller's options are not mutated");
});
