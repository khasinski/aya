// An agent rarely sets another status once the user has answered, so the user's Enter into the pane clears
// `aya status waiting`, as `aya status clear` would, and tells the windows.

import { test } from "node:test";
import assert from "node:assert/strict";

const { recordAgentStatus, agentWaitingSince, noteUserAnswer } = await import("../dist-electron/agent-status.js");
// The screen shows no CLI dialog: the Enter is for the agent.
const FREE = async () => null;

// [label, status the pane has, what the user typed, cleared]
const ROWS = [
  ["waiting, then Enter", "waiting", "\r", true],
  ["waiting, then a typed line with its Enter", "waiting", "go on\r", true],
  ["waiting, then a pasted line break", "waiting", "yes\n", true],
  ["waiting, then letters only", "waiting", "go on", false],
  ["waiting, then an arrow key", "waiting", "\x1b[A", false],
  ["waiting, then Ctrl-C", "waiting", "\x03", false],
  ["no status, then Enter", null, "\r", false],
  ["done, then Enter", "done", "\r", false],
  ["error, then Enter", "error", "\r", false],
  ["active, then Enter", "active", "\r", false],
  ["cleared already, then Enter", "clear", "\r", false],
];
for (const [label, status, typed, cleared] of ROWS) {
  test(`user input | ${label}`, async () => {
    const pane = `pane-${label}`;
    if (status) recordAgentStatus(pane, status, 1000);
    const update = await noteUserAnswer(pane, typed, FREE, 5000);
    if (!cleared) {
      assert.equal(update, null);
      assert.equal(agentWaitingSince(pane), status === "waiting" ? 1000 : null);
      return;
    }
    assert.deepEqual(update, { terminalId: pane, level: "clear", updatedAt: 5000 });
    assert.equal(agentWaitingSince(pane), null, "the main process agrees: it is no longer waiting");
    assert.equal(await noteUserAnswer(pane, "\r", FREE, 6000), null, "once");
  });
}

test("user input | another pane's question stays", async () => {
  recordAgentStatus("lead", "waiting", 1000);
  recordAgentStatus("other", "waiting", 1000);
  assert.ok(await noteUserAnswer("other", "\r", FREE, 2000));
  assert.equal(agentWaitingSince("lead"), 1000);
});
