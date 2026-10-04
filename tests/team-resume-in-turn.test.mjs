// The user's Resume and the lead's `aya team start "<task>"` ending its own pause both type the owed Start task,
// so both wait their turn in the team's queue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const TEAM = `# ux-review

## Role: leader
Sends to: implementer (the next step)
Must not: edit code

## Role: implementer
Sends to: leader (what changed)
Must not: skip the tests

## Lead
leader
`;

function latch() {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { opened, open };
}

for (const [first, tasks] of [["start", 1], ["resume", 0]]) {
  test(`the lead's Start with a task and the user's Resume at once | ${first} first: the task typed ${tasks} time(s)`, async () => {
    const t = teamProject("aya-resume-turn-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-i" }] });
    try {
      const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
      await store.assign("leader", "pane-l");
      await store.assign("implementer", "pane-i");
      await store.setPaused(true, "leader");
      const firstLook = latch();
      const go = latch();
      const taskPasted = latch();
      const typed = [];
      let looked = false;
      const runner = new TeamRunner(
        {
          teamHome: t.teamHome,
          listProjects: async () => [t.project],
          deliver: async (pane, text) => {
            typed.push(text);
            if (text.includes("TASK-XYZ")) taskPasted.open();
          },
          // Either call reads HEAD once the team is unpaused (its progress starts over), the Start's task already owed:
          // the first call waits there until the other has had its chance.
          headCommit: async () => {
            if (!looked) {
              looked = true;
              firstLook.open();
              await go.opened;
            }
            return null;
          },
          holdReason: async () => null,
        },
        () => () => {},
        Date.now,
        () => {},
      );
      const start = () => runner.start("game", "ux-review", { text: "TASK-XYZ", to: "implementer" }, "leader");
      const resume = () => runner.resume("game", "ux-review");
      const one = first === "start" ? start() : resume();
      await firstLook.opened;
      const other = first === "start" ? resume() : start();
      // The other call types the task at once when it does not wait its turn; in turn it has nothing to show yet.
      await Promise.race([taskPasted.opened, new Promise((resolve) => setTimeout(resolve, 300))]);
      go.open();
      const results = await Promise.all([one, other]);
      const started = results.find((r) => r && "started" in r);
      assert.equal(started.started ? 1 : started.alreadyRunning ? 0 : -1, tasks, JSON.stringify(started));
      assert.equal(typed.filter((text) => text.includes("TASK-XYZ")).length, tasks, JSON.stringify(typed));
      assert.equal((await store.log()).filter((m) => m.text === "TASK-XYZ").length, tasks);
    } finally {
      t.cleanup();
    }
  });
}
