// A Pause while the leader's round waits for the leader pane's lock: cancellation is checked once the lock is
// held, before the paste, so nothing of the round reaches the composer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { deliverTeamMessage } = await import("../dist-electron/control.js");
const { PaneHeldError } = await import("../dist-electron/team-control.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { TEAM_MINUTE_MS } = await import("../dist-electron/paths.js");

// [label, when the send is cancelled, writes the pane gets, what the send ends as]
const ROWS = [
  ["not cancelled", null, ["paste", "enter"], "ok"],
  ["cancelled while queued behind another send, before the paste", "queued", [], "held, nothing typed"],
  ["cancelled while the pane's hold is read, once the lock is held", "during hold read", [], "held, nothing typed"],
  ["cancelled after the paste, before Enter", "after paste", ["paste"], "held, typed"],
];
for (const [label, when, expected, ends] of ROWS) {
  test(`deliverTeamMessage behind the pane lock | ${label}`, async () => {
    const writes = [];
    let release;
    const gate = new Promise((r) => (release = r));
    let cancel = false;
    let firstEnter = true;
    const write = async (_id, data) => {
      if (data.includes("benchmarker report")) {
        await gate;
        return true;
      }
      if (data === "\r" && firstEnter) return !(firstEnter = false); // the report's own Enter
      writes.push(data === "\r" ? "enter" : "paste");
      if (when === "after paste" && data !== "\r") cancel = true;
      return true;
    };
    const first = deliverTeamMessage(write, "pane-l", "benchmarker report: 412 nodes", async () => null);
    const hold = async () => {
      if (when === "during hold read") cancel = true;
      return null;
    };
    const round = deliverTeamMessage(write, "pane-l", "Round 4: go", hold, () => cancel).then(() => null, (e) => e);
    if (when === "queued") cancel = true;
    release();
    await first;
    const result = await round;
    assert.deepEqual(writes, expected);
    if (ends === "ok") assert.equal(result, null);
    else {
      assert.ok(result instanceof PaneHeldError, String(result));
      assert.equal(result.typed, ends === "held, typed", "typed");
    }
  });
}

const TEAM = `# ux-review

## Role: leader
Sends to: implementer (the next step), benchmarker (what to measure)
Must not: edit code

## Role: implementer
Sends to: benchmarker (a solver to measure)
Must not: skip the tests

## Role: benchmarker
Sends to: leader (node counts)
Must not: change the solver

## Lead
leader

## Cadence
leader every 3 min
`;

test("sudoku step 9: Pause while the leader's round waits for the pane lock leaves no 'Round N' in the composer", async () => {
  const t = teamProject("aya-lockqueue-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-i" }, { id: "pane-b" }] });
  try {
    const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
    await store.assign("leader", "pane-l");
    await store.assign("implementer", "pane-i");
    await store.assign("benchmarker", "pane-b");
    await store.setPaused(false);
    const writes = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const write = async (id, data) => {
      writes.push({ id, data });
      if (data.includes("benchmarker report")) await gate;
      return true;
    };
    let roundQueued;
    const queued = new Promise((r) => (roundQueued = r));
    const jobs = [];
    const deps = {
      teamHome: t.teamHome,
      listProjects: async () => [t.project],
      deliver: (pane, text, cancelled) => {
        const sent = deliverTeamMessage(write, pane, text, async () => null, cancelled);
        if (/Aya round \d+:/.test(text)) roundQueued();
        return sent;
      },
      headCommit: async () => null,
      holdReason: async () => null,
    };
    let clock = Date.now();
    const runner = new TeamRunner(deps, (fn) => (jobs.push(fn), () => {}), () => clock, () => {});
    await runner.resume("game", "ux-review");
    clock += 3 * TEAM_MINUTE_MS;
    // The benchmarker's report is being typed into the leader's pane and holds its lock.
    const report = deliverTeamMessage(write, "pane-l", "[team ux-review | from benchmarker] benchmarker report: 412 nodes", async () => null);
    const tick = jobs.at(-1)();
    await queued;
    await runner.pause("game", "ux-review");
    release();
    await report;
    await tick;
    const rounds = writes.filter((w) => w.id === "pane-l" && /Aya round \d+:/.test(w.data));
    assert.deepEqual(rounds, [], "nothing of the round reached the leader's composer after the Pause");
    assert.equal(await store.lastRound(), 0, "the round was not typed: its number is not used up");
    const entry = (await store.log()).filter((m) => m.from === "aya" && m.to === "leader").at(-1);
    assert.ok(!entry?.typedOnly, "the log does not say it was left in the composer");
  } finally {
    t.cleanup();
  }
});
