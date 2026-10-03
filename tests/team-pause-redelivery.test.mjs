// A held report whose redelivery waits for the receiver's pane lock when the user clicks Pause types nothing
// after the Pause and stays owed, then goes out once after Resume.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
tester
`;

async function world() {
  const t = teamProject("aya-pause-redelivery-", { teamFile: TEAM, tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  await store.setPaused(false);
  const writes = [];
  let release;
  let reportQueued;
  const queued = new Promise((r) => (reportQueued = r));
  const gate = new Promise((r) => (release = r));
  // Another message is being typed into the implementer's pane and holds its lock until released.
  const write = async (id, data) => {
    if (data.includes("someone else's message")) await gate;
    else writes.push({ id, data });
    return true;
  };
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: (pane, text, cancelled) => {
      const sending = deliverTeamMessage(write, pane, text, async () => null, cancelled);
      if (text.includes("the timer test fails")) reportQueued();
      return sending;
    },
    headCommit: async () => null,
    holdReason: async () => null,
  };
  const runner = new TeamRunner(deps, () => () => {}, Date.now, () => {});
  const typedReport = () => writes.filter((w) => w.id === "pane-i" && w.data.includes("the timer test fails")).length;
  return { ...t, store, runner, write, release, queued, typedReport };
}

for (const when of ["before the pass", "while the pass waits for the pane"]) {
  test(`Pause ${when}: the held report is not typed, stays owed, and goes out once after Resume`, async () => {
    const w = await world();
    try {
      await w.store.append({ from: "tester", to: "implementer", commit: null, text: "report: the timer test fails on CI", delivered: false, held: "has text the user is typing" });
      const other = deliverTeamMessage(w.write, "pane-i", "someone else's message", async () => null);
      if (when === "before the pass") await w.runner.pause("game", "ux-review");
      const pass = w.runner.redeliverWaiting();
      if (when !== "before the pass") {
        // The pass has reached delivery and is queued behind the gated paste.
        await w.queued;
        await w.runner.pause("game", "ux-review");
      }
      w.release();
      await other;
      assert.equal(await pass, 0, "nothing typed by the pass");
      assert.equal(w.typedReport(), 0, "nothing of the report reached the pane after the Pause");
      assert.equal((await w.store.unread("implementer")).length, 1, "the report is still owed");
      await w.runner.resume("game", "ux-review");
      assert.equal(await w.runner.redeliverWaiting(), 1);
      assert.equal(await w.runner.redeliverWaiting(), 0);
      assert.equal(w.typedReport(), 1, "pasted once after Resume");
    } finally {
      w.cleanup();
    }
  });
}
