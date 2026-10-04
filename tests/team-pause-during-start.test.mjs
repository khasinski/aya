// A Pause that comes while Start, Resume or a new pane's introduce is typing stops there, as it does for a send
// or a round: nothing more is pasted and no clock is armed on the paused team.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { PaneHeldError } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: leader
Sends to: implementer (the next step)
Must not: edit code

## Role: implementer
Sends to: leader (what changed)
Must not: skip the tests

## Role: benchmarker
Sends to: leader (node counts)
Must not: change the solver

## Lead
leader
`;
const PANES = { leader: "pane-l", implementer: "pane-i", benchmarker: "pane-b" };
const TASK = "measure the hard puzzles";

async function world() {
  const t = teamProject("aya-pause-start-", { teamFile: TEAM, tabs: Object.values(PANES).map((id) => ({ id })) });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  for (const [role, pane] of Object.entries(PANES)) await store.assign(role, pane);
  const w = { typed: [], onPaste: null, clocks: 0 };
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    // As main's deliver: a Pause that came while the paste waited for the pane's lock types nothing.
    deliver: async (pane, text, cancelled) => {
      const hook = w.onPaste;
      if (hook && hook(text)) {
        w.onPaste = null;
        await runner.pause("game", "ux-review");
      }
      if (cancelled?.()) throw new PaneHeldError("the team was paused or changed before it was typed; nothing typed", false);
      w.typed.push({ pane, text });
    },
    headCommit: async () => null,
    holdReason: async () => null,
  };
  const schedule = () => {
    w.clocks += 1;
    return () => (w.clocks -= 1);
  };
  const runner = new TeamRunner(deps, schedule, Date.now, () => {});
  return { ...t, store, w, runner, deps, cleanup: () => (runner.stopAll(), t.cleanup()) };
}

const pauseTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const t = await world(...args);
    try {
      await fn(t);
    } finally {
      t.cleanup();
    }
  });
};

const tests = (w) => w.typed.filter((x) => x.text.includes("Delivery test"));
const tasks = (w) => w.typed.filter((x) => x.text.includes(TASK));
const firstPaste = () => true;

const ACTIONS = {
  "Start with a task": async (w) => w.runner.start("game", "ux-review", { text: TASK, to: "implementer" }),
  "Start without a task": async (w) => w.runner.start("game", "ux-review"),
  "Resume owing a task": async (w) => {
    await w.runner.start("game", "ux-review");
    await w.runner.pause("game", "ux-review");
    await w.store.setPendingTask({ to: "implementer", text: TASK });
    w.w.typed.length = 0;
    return "resume";
  },
  // A Start that went down after logging its task, before typing it: Resume types the logged one.
  "Resume owing a logged task": async (w) => {
    await w.runner.start("game", "ux-review");
    await w.runner.pause("game", "ux-review");
    const after = (await w.store.log()).at(-1).id;
    await w.store.setPendingTask({ to: "implementer", text: TASK, after });
    await w.store.append({ from: "user", to: "implementer", commit: null, text: TASK, delivered: false });
    w.w.typed.length = 0;
    return "resume";
  },
  "introduce on a running team": async (w) => {
    await w.runner.start("game", "ux-review");
    w.w.typed.length = 0;
    return "introduce";
  },
};

for (const [action, prepare] of Object.entries(ACTIONS)) {
  pauseTest(`Pause during the first paste | ${action} -> one paste at most, nothing after it, no clock, the task still owed`, async (t) => {
    const kind = action.startsWith("Start") ? null : await prepare(t);
    t.w.onPaste = firstPaste;
    if (kind === "resume") await t.runner.resume("game", "ux-review");
    else if (kind === "introduce") await t.runner.introduce("game", "ux-review", "benchmarker");
    else await prepare(t);
    assert.deepEqual(t.w.typed, [], "the Pause came before the first paste went: nothing typed");
    assert.equal(t.w.clocks, 0, "no clock runs on the paused team");
    assert.equal((await t.store.state()).paused, true);
    if (action !== "Start without a task" && action !== "introduce on a running team") {
      assert.equal(tasks(t.w).length, 0, "the task was not typed");
      await t.runner.resume("game", "ux-review");
      await t.runner.redeliverWaiting();
      assert.equal(tasks(t.w).length, 1, "after Resume the task is typed, once");
    }
  });
}

pauseTest("Pause during the second delivery test of a Start with a task -> the third test and the task are not typed; Resume types the task once", async (t) => {
  let pastes = 0;
  t.w.onPaste = () => ++pastes === 2;
  await t.runner.start("game", "ux-review", { text: TASK, to: "implementer" });
  assert.equal(tests(t.w).length, 1, "only the test pasted before the Pause");
  assert.equal(tasks(t.w).length, 0);
  assert.equal(t.w.clocks, 0);
  await t.runner.resume("game", "ux-review");
  await t.runner.redeliverWaiting();
  assert.equal(tasks(t.w).length, 1);
  assert.equal(t.w.clocks, 1, "Resume runs the clock");
});

pauseTest("no Pause | Start with a task -> every test and the task typed, one clock", async (t) => {
  await t.runner.start("game", "ux-review", { text: TASK, to: "implementer" });
  assert.equal(tests(t.w).length, 3);
  assert.equal(tasks(t.w).length, 1);
  assert.equal(t.w.clocks, 1);
});
