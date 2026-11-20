// main.ts's native windows that quote tab and project names: the waiting-for-input notification and the yes/no before
// a restart that stops background work. Those names come from config files an agent can write too, so they are shown
// as text: each acting character as its escape, the rest as is.

import { test } from "node:test";
import assert from "node:assert/strict";

const { DIALOG_LIST_LIMIT, dialogDetail, dialogList, quietWhenTesting, restartDialog, waitingNotification } = await import("../dist-electron/native-ui-text.js");

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

// A native message box grows with its text and does not scroll, so a long list pushes its buttons off the screen.
test("a dialog list shows the first panes one per short line and counts the rest", () => {
  const panes = Array.from({ length: 30 }, (_, i) => `pane ${i} (PID ${1000 + i})`);
  const lines = dialogList(panes).split("\n");
  assert.equal(lines.length, DIALOG_LIST_LIMIT + 1);
  assert.equal(lines[0], "pane 0 (PID 1000)");
  assert.equal(lines.at(-1), `and ${30 - DIALOG_LIST_LIMIT} more`);
  assert.equal(dialogList(["a", "b"]), "a\nb", "a short list is left whole, with no count");
  assert.equal(dialogList([]), "");
});

test("a dialog list cuts a long or multi-line name to one line and keeps its summary lines", () => {
  const [line] = dialogList([`build\n${"x".repeat(500)}`]).split("\n");
  assert.ok(line.length <= 90 && line.endsWith("…") && !line.includes("\n"), line);
  const withSummary = dialogList(Array.from({ length: 20 }, (_, i) => `p${i}`), ["3 more unknown"]).split("\n");
  assert.deepEqual(withSummary.slice(-2), [`and ${20 - DIALOG_LIST_LIMIT} more`, "3 more unknown"]);
  assert.equal(dialogList([], ["3 more unknown"]), "3 more unknown");
});

test("the restart dialog's detail is bounded whatever text it is given", () => {
  const huge = Array.from({ length: 400 }, (_, i) => `pane ${i}: a very long running command line`).join("\n");
  const { detail } = restartDialog("Restart", huge);
  assert.ok(detail.split("\n").length <= 22, `${detail.split("\n").length} lines`);
  assert.ok(detail.length <= 1600);
  assert.equal(detail.split("\n").at(-1), "…");
  assert.ok(dialogDetail("y".repeat(5000)).length <= 1600);
  assert.equal(dialogDetail("short\ntext"), "short\ntext");
});
