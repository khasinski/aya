// The clock looks every few seconds; a team message's Enter is checked for a turn for up to 6 s after its paste.
// A look in between must not decide whether that message was talk: only how its Enter went does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { TeamStore } = await import("../dist-electron/team-store.js");
const { deliverAndLog } = await import("../dist-electron/team-control.js");
const { observe } = await import("../dist-electron/team-progress.js");

for (const [enter, unseen, talk] of [
  ["started a turn", null, 1],
  ["was not seen to start a turn", "typed, not seen to start a turn", 0],
]) {
  test(`a look of the clock during the Enter check, then the Enter ${enter}: ${talk} message of talk`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aya-talk-in-flight-"));
    try {
      const store = new TeamStore(join(root, "team"));
      await store.assign("implementer", "pane-i");
      let release;
      const checked = new Promise((resolve) => (release = resolve));
      let pasted;
      const inPane = new Promise((resolve) => (pasted = resolve));
      const deps = {
        deliver: async () => (pasted(), await checked, unseen),
        holdReason: async () => null,
        headCommit: async () => "abc1234",
      };
      const sent = deliverAndLog(deps, { directory: root }, store, { team: "ux-review", from: "tester", to: "implementer", text: "round 5 ready" });
      await inPane;
      await observe(store, "abc1234", {}, new Date().toISOString());
      release();
      await sent;
      const progress = await observe(store, "abc1234", {}, new Date().toISOString());
      assert.equal(progress.messages ?? 0, talk);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
