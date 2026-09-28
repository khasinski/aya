// Every team state x every receiving-pane state x every action, with the
// expected outcome spelled out. Teams are state machines; a bug on
// 2026-09-28 lived in a combination (running team + restart + old held
// rounds) that each single-state test passed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Cadence
implementer every 30 min
`;

// The implementer is the receiver in every case; the tester's pane is free.
const PANE_STATES = {
  free: null,
  "no pane": "no pane assigned",
  "not running": "is not running (exited, or its tab was not opened yet)",
  "starting up": "is still starting up",
  "approval prompt": "shows an approval prompt",
  "user typing": "has text the user is typing",
  shell: "runs a shell",
};
const TEAM_STATES = ["never started", "running", "paused"];

async function world(teamState, paneState) {
  const { teamHome, project, cleanup } = teamProject("aya-states-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  if (paneState !== "no pane") await store.assign("implementer", "pane-i");
  if (teamState === "running") await store.setPaused(false);
  if (teamState === "paused") await store.setPaused(true);
  const typed = [];
  const scheduled = [];
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async (pane) => (pane === "pane-i" ? PANE_STATES[paneState] : null),
    headCommit: async () => null,
  };
  const runner = new TeamRunner(deps, (fn, ms) => {
    const job = { fn, ms };
    scheduled.push(job);
    return () => {};
  });
  const toImplementer = () => typed.filter((w) => w.pane === "pane-i");
  const lastLog = async () => (await store.log()).at(-1);
  return { store, deps, runner, typed, scheduled, toImplementer, lastLog, cleanup };
}

const reason = (paneState) => PANE_STATES[paneState];

for (const teamState of TEAM_STATES) {
  for (const paneState of Object.keys(PANE_STATES)) {
    const label = `${teamState} team, receiver ${paneState}`;

    test(`aya team send | ${label}`, async () => {
      const w = await world(teamState, paneState);
      try {
        const send = handleTeamRequest({ type: "team-send", role: "implementer", text: "report 1" }, "pane-t", w.deps);
        if (teamState === "paused") {
          await assert.rejects(send, /paused; nothing was sent/);
          assert.equal((await w.store.log()).length, 0, "a paused team logs nothing");
        } else if (paneState === "free") {
          assert.match((await send).output, /written to implementer's pane/);
          assert.equal(w.toImplementer().length, 1);
          assert.equal((await w.lastLog()).delivered, true);
        } else {
          await assert.rejects(send, new RegExp(`implementer: ${reason(paneState).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; nothing was typed`));
          assert.equal(w.toImplementer().length, 0, "never typed into a held pane");
          assert.deepEqual([(await w.lastLog()).delivered, (await w.lastLog()).held], [false, reason(paneState)]);
        }
      } finally {
        w.cleanup();
      }
    });

    test(`assign (introduce) | ${label}`, async () => {
      const w = await world(teamState, paneState);
      try {
        const why = await w.runner.introduce("game", "ux-review", "implementer");
        if (teamState !== "running") {
          assert.equal(why, null);
          assert.equal(w.typed.length, 0, "only a running team introduces; otherwise Start does");
        } else if (paneState === "free") {
          assert.equal(why, null);
          assert.match(w.toImplementer()[0].text, /Delivery test/);
        } else {
          assert.equal(why, reason(paneState));
          assert.equal(w.typed.length, 0);
        }
      } finally {
        w.cleanup();
      }
    });

    test(`Start | ${label}`, async () => {
      const w = await world(teamState, paneState);
      try {
        const before = await w.store.state();
        const result = await w.runner.start("game", "ux-review");
        if (paneState === "free") {
          assert.deepEqual([result.started, result.delivered.sort()], [true, ["implementer", "tester"]]);
          assert.deepEqual(await w.store.state(), { paused: false, running: true });
          assert.equal(w.scheduled.length, 1, "rounds armed");
        } else {
          assert.deepEqual(result, { started: false, delivered: [], held: [{ role: "implementer", reason: reason(paneState) }] });
          assert.equal(w.typed.length, 0, "one pane not ready: nothing is sent to anyone");
          assert.equal((await w.store.log()).length, 0);
          assert.deepEqual(await w.store.state(), before, "the team state does not change");
          assert.equal(w.scheduled.length, 0);
        }
      } finally {
        w.cleanup();
      }
    });

    test(`restore after a restart, then a round | ${label}`, async () => {
      const w = await world(teamState, paneState);
      try {
        await w.runner.restore();
        if (teamState !== "running") {
          assert.equal(w.scheduled.length, 0, "only a running team gets its rounds back");
          return;
        }
        assert.equal(w.scheduled.length, 1);
        await w.scheduled[0].fn();
        if (paneState === "free") {
          assert.match(w.toImplementer()[0].text, /Round 1:/);
        } else {
          assert.equal(w.typed.length, 0, "a held pane skips the round");
          assert.deepEqual([(await w.lastLog()).from, (await w.lastLog()).held], ["aya", reason(paneState)]);
        }
      } finally {
        w.cleanup();
      }
    });

    test(`redelivery of held messages | ${label}`, async () => {
      const w = await world(teamState, paneState);
      try {
        // What an earlier session left: a stale round and delivery test, and a peer report.
        await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Round 1: old", delivered: false, held: "shows an approval prompt" });
        await w.store.append({ from: "aya", to: "implementer", commit: null, text: "Delivery test: old", delivered: false, held: "no pane assigned" });
        await w.store.append({ from: "tester", to: "implementer", commit: null, text: "peer report", delivered: false, held: "shows an approval prompt" });
        const typed = await w.runner.redeliverWaiting();
        if (teamState !== "paused" && paneState === "free") {
          assert.equal(typed, 1);
          assert.deepEqual(w.toImplementer().map((x) => x.text.replace(/^.*\] /, "")), ["peer report"], "Aya's own old messages never go out");
        } else {
          assert.equal(typed, 0);
          assert.equal(w.typed.length, 0);
        }
      } finally {
        w.cleanup();
      }
    });
  }
}

test("pause stops rounds and sends; resume brings rounds back without resending delivery tests", async () => {
  const w = await world("never started", "free");
  try {
    await w.runner.start("game", "ux-review");
    w.typed.length = 0;
    await w.runner.pause("game", "ux-review");
    assert.deepEqual(await w.store.state(), { paused: true, running: false });
    await w.scheduled[0].fn();
    assert.equal(w.typed.length, 0, "a paused team's round does nothing");
    await w.runner.resume("game", "ux-review");
    assert.deepEqual(await w.store.state(), { paused: false, running: true });
    assert.equal(w.typed.length, 0, "resume sends no delivery tests");
    await w.scheduled.at(-1).fn();
    assert.equal(w.toImplementer().length, 1);
  } finally {
    w.cleanup();
  }
});
