// A message typed without becoming a turn says why its Enter was withheld or what came of it; main records
// which one it was (`afterEnter`) and the readers use that, not the reason's wording.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { TeamStore } = await import("../dist-electron/team-store.js");
const { deliverAndLog, PaneHeldError, TextPastedError, ENTER_FAILED } = await import("../dist-electron/team-control.js");
const { TURN_NOT_SEEN } = await import("../dist-electron/control.js");
const { messageDeliveryText, startSummary } = await import("../dist-test/team-view.js");

// [how the paste ended, deliver, held recorded, afterEnter]
const ENDINGS = [
  ["a hold came up before the Enter", async () => { throw new PaneHeldError("shows an approval prompt", true); }, "shows an approval prompt", false],
  ["the Enter did not go through", async () => { throw new TextPastedError("gone"); }, ENTER_FAILED, true],
  ["the Enter started no turn", async () => TURN_NOT_SEEN, TURN_NOT_SEEN, true],
];

for (const [label, deliver, held, afterEnter] of ENDINGS) {
  test(`typed without a turn | ${label}: recorded afterEnter ${afterEnter}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aya-after-enter-"));
    try {
      const store = new TeamStore(join(root, "team"));
      await store.assign("implementer", "pane-i");
      const deps = { deliver, holdReason: async () => null, headCommit: async () => null };
      const { entry } = await deliverAndLog(deps, { directory: root }, store, { team: "t", from: "tester", to: "implementer", text: "round 5 ready" });
      const [logged] = await store.annotatedLog();
      for (const m of [entry, logged]) {
        assert.equal(m.typedOnly, true);
        assert.equal(m.held, held);
        assert.equal(m.afterEnter ?? false, afterEnter);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// The flag decides, not the wording: a reason that happens to start "typed," and one that does not.
// [label, entry, window line]
const LINES = [
  ["withheld, a reason starting with 'typed,'", { held: "typed, then the pane closed", afterEnter: false }, "typed, Enter withheld: typed, then the pane closed"],
  ["after the Enter, a reason without 'typed,'", { held: "the Enter met a dialog: shows a numbered choice", afterEnter: true }, "the Enter met a dialog: shows a numbered choice"],
];
for (const [label, fields, line] of LINES) {
  test(`typed without a turn | the window's line follows afterEnter | ${label}`, () => {
    assert.equal(messageDeliveryText({ from: "tester", delivered: true, typedOnly: true, ...fields }), line);
    const task = { to: "implementer", held: fields.held, typedOnly: true, afterEnter: fields.afterEnter, messageId: 1 };
    const said = startSummary({ started: true, delivered: ["implementer"], held: [], task });
    assert.equal(said, fields.afterEnter ? `Started; task for implementer was ${fields.held}.` : `Started; task for implementer is typed in its composer, Enter withheld: ${fields.held}.`);
  });
}
