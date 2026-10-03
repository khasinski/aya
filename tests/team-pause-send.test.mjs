// A Pause stops `aya team send` between roles, also one that lands while the send waits for the receiver's pane lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
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

// [when the Pause lands, writes of the implementer's report into the leader's pane, what the send ends as, logged as owed later]
const ROWS = [
  ["no Pause", null, ["paste", "enter"], "written", false],
  ["before the send", "before", [], /team ux-review is paused; nothing was sent/, null],
  ["while the send waits for the pane lock (another message is being typed there)", "queued", [], /paused.*nothing was typed/, true],
  ["after the paste, before Enter", "after paste", ["paste"], /paused.*not resent/, false],
];

for (const [label, when, writes, ends, owed] of ROWS) {
  test(`aya team send, Pause ${label}`, async () => {
    const t = teamProject("aya-pause-send-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-i" }] });
    try {
      const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
      await store.assign("leader", "pane-l");
      await store.assign("implementer", "pane-i");
      const reportWrites = [];
      let release;
      let reportQueued;
      const queued = new Promise((r) => (reportQueued = r));
      const gate = new Promise((r) => (release = r));
      let pause = async () => {};
      let firstEnter = true;
      const write = async (_id, data) => {
        if (data.includes("benchmark output")) {
          await gate;
          return true;
        }
        if (data === "\r" && firstEnter && when === "queued") return !(firstEnter = false); // the other message's Enter
        reportWrites.push(data === "\r" ? "enter" : "paste");
        if (when === "after paste" && data !== "\r") await pause();
        return true;
      };
      const deps = {
        teamHome: t.teamHome,
        listProjects: async () => [t.project],
        deliver: (pane, text, cancelled) => {
          const sending = deliverTeamMessage(write, pane, text, async () => null, cancelled);
          if (text.includes("naked pairs in")) reportQueued();
          return sending;
        },
        headCommit: async () => null,
        holdReason: async () => null,
      };
      const runner = new TeamRunner(deps, () => () => {}, Date.now, () => {});
      await runner.start("game", "ux-review");
      reportWrites.length = 0;
      firstEnter = true; // the delivery tests' Enters are not the other message's
      pause = () => runner.pause("game", "ux-review");
      if (when === "before") await pause();
      // Another message holds the leader pane's lock while the report is sent.
      const other = when === "queued" ? deliverTeamMessage(write, "pane-l", "benchmark output: 412 nodes", async () => null) : null;
      const logBefore = (await store.log()).length;
      const send = handleTeamRequest({ type: "team-send", role: "leader", text: "naked pairs in, 489 nodes total" }, "pane-i", deps).then(
        (r) => r.output,
        (e) => e,
      );
      if (when === "queued") {
        // Pause once the report reached delivery and is queued behind the gated paste.
        await queued;
        await pause();
        release();
        await other;
      }
      const result = await send;
      assert.deepEqual(reportWrites, writes, "what reached the leader's pane");
      if (ends === "written") assert.match(result, /written to leader's pane/);
      else assert.match(String(result), ends);
      const logged = (await store.log()).slice(logBefore).filter((m) => m.from === "implementer");
      if (owed === null) assert.deepEqual(logged, [], "refused before anything: nothing logged");
      else if (owed) assert.deepEqual([logged.length, logged[0].delivered], [1, false], "kept for after the Resume, not typed now");
      else assert.equal(logged.length, 1);
      runner.stopAll();
    } finally {
      t.cleanup();
    }
  });
}
