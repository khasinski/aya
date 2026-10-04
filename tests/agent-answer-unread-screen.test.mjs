// An old terminal host (after an update) does not answer the screen read: "cannot be checked" is no read, so the
// user's Enter does not end the agent's question then (it may answer a CLI dialog); a later Enter does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-answer-unread-"));
const { recordAgentStatus, agentWaitingSince, noteUserAnswer } = await import("../dist-electron/agent-status.js");
const { PANE_HOLD_UNKNOWN } = await import("../dist-electron/pty-host-client.js");

// [label, what the screen read gives, the question ends]
const ROWS = [
  ["the host did not answer (an old host after an update)", async () => PANE_HOLD_UNKNOWN, false],
  ["the screen read failed", async () => { throw new Error("socket closed"); }, false],
  ["the composer, read", async () => null, true],
];

for (const [label, screen, answered] of ROWS) {
  test(`the user's Enter on a screen Aya could not read | ${label}`, async () => {
    const pane = `unread-${label}`;
    recordAgentStatus(pane, "waiting", 1000, "which db?");
    const update = await noteUserAnswer(pane, "\r", screen, 5000);
    assert.equal(update !== null, answered);
    assert.equal(agentWaitingSince(pane), answered ? null : 1000);
  });
}

test("the user's Enter on a screen Aya could not read | the next Enter, once the host answers, ends the question", async () => {
  recordAgentStatus("unread-then-read", "waiting", 1000, "which db?");
  assert.equal(await noteUserAnswer("unread-then-read", "\r", async () => PANE_HOLD_UNKNOWN, 2000), null);
  assert.deepEqual(await noteUserAnswer("unread-then-read", "postgres\r", async () => null, 3000), { terminalId: "unread-then-read", level: "clear", updatedAt: 3000 });
});
