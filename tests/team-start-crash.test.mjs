// Start writes "running" before it types the delivery tests and the task: Aya going down in between must not
// lose the user's task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report

## Lead
lead
`;

class Crash extends Error {}

async function setup() {
  const t = teamProject("aya-start-crash-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  const typed = [];
  const w = { crashAtHeadCall: Infinity, calls: 0, held: {} };
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async (pane) => w.held[pane] ?? null,
    headCommit: async () => {
      if (++w.calls >= w.crashAtHeadCall) throw new Crash("the app went down");
      return null;
    },
  };
  const none = () => () => {};
  const runner = () => new TeamRunner(deps, none, Date.now);
  return { ...t, store, typed, w, runner };
}

const crashTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const t = await setup(...args);
    try {
      await fn(t);
    } finally {
      t.cleanup();
    }
  });
};

const tasks = (typed) => typed.filter((m) => m.text.includes("write the solver"));

// Calls to headCommit in Start: 1 freshProgress, 2-3 the delivery tests, 4 the task.
const CRASH_AT = [
  ["before the first delivery test", 2],
  ["between the delivery tests and the task", 4],
];
for (const [when, call] of CRASH_AT) {
  crashTest(`Aya goes down ${when}: the next launch types the task once`, async (t) => {
    t.w.crashAtHeadCall = call;
    await assert.rejects(t.runner().start("game", "ux-review", { text: "write the solver" }), Crash);
    assert.equal(tasks(t.typed).length, 0, "the crash came before the task");
    assert.equal((await t.store.state()).running, true, "Start had already written running");
    t.w.crashAtHeadCall = Infinity;
    await t.runner().restore();
    assert.equal(tasks(t.typed).length, 1);
    assert.equal(tasks(t.typed)[0].pane, "pane-l", "to the lead");
    assert.match(tasks(t.typed)[0].text, /^\[team ux-review \| from user \| \d\d:\d\d\] write the solver$/);
    await t.runner().restore();
    await t.runner().restore();
    assert.equal(tasks(t.typed).length, 1, "later launches do not type it again");
  });
}

// A force-quit around the task's paste must never type it twice, nor lose it.
const realClear = TeamStore.prototype.setPendingTask;
const realAppend = TeamStore.prototype.append;
// The task is logged before its paste (the reservation every message takes), so both crashes come before the paste.
const CRASH_AFTER_TYPING = [
  ["after the task was logged, before the owed task was cleared", "clear", { logged: 1, note: null }],
  ["while the task was being logged", "append", { logged: 1, note: null }],
];
for (const [when, at, expected] of CRASH_AFTER_TYPING) for (const paused of [false, true]) {
  test(`N6.4 Aya goes down ${when}${paused ? ", the team paused, then resumed" : ""}: the task is in the pane once and in the log once`, async () => {
    const t = await setup();
    let armed = true;
    TeamStore.prototype.setPendingTask = function (task) {
      if (at === "clear" && task === null && armed) return Promise.reject(new Crash("the app went down"));
      return realClear.call(this, task);
    };
    TeamStore.prototype.append = function (entry) {
      if (at === "append" && entry.from === "user" && armed) return Promise.reject(new Crash("the app went down"));
      return realAppend.call(this, entry);
    };
    try {
      await assert.rejects(t.runner().start("game", "ux-review", { text: "write the solver" }));
      assert.equal(tasks(t.typed).length, 0, "the crash came before the paste");
      armed = false;
      if (paused) {
        await t.store.setPaused(true);
        const runner = t.runner();
        await runner.restore();
        await runner.resume("game", "ux-review");
      }
      await t.runner().restore();
      await t.runner().restore();
      assert.equal(tasks(t.typed).length, 1, "the relaunch types it once");
      const fromUser = (await t.store.annotatedLog()).filter((m) => m.from === "user");
      assert.equal(fromUser.length, expected.logged, "one log entry for the task");
      if (expected.note) assert.match(fromUser[0].held ?? "", expected.note);
      assert.equal(await t.store.pendingTask(), null, "nothing owed any more");
      assert.equal((await t.store.unread("lead")).length, 0, "not left for a redelivery either");
    } finally {
      TeamStore.prototype.setPendingTask = realClear;
      TeamStore.prototype.append = realAppend;
      t.cleanup();
    }
  });
}

// The log check looks only at entries after the owed task was set: the same text from an earlier Start is not this one.
for (const [label, owed] of [["recorded after the earlier one", (lastId) => ({ after: lastId })], ["from before the log check (no mark)", () => ({})]]) {
  crashTest(`N6.4 an owed task ${label} with the same text as an earlier, typed task: it is typed`, async (t) => {
    await t.runner().start("game", "ux-review", { text: "write the solver" });
    const lastId = (await t.store.log()).at(-1).id;
    await t.store.setPendingTask({ to: "lead", text: "write the solver", ...owed(lastId) });
    await t.runner().restore();
    assert.equal(tasks(t.typed).length, 2);
    assert.equal(await t.store.pendingTask(), null);
  });
}

crashTest("after the task was typed, a relaunch does not type it again", async (t) => {
  await t.runner().start("game", "ux-review", { text: "write the solver" });
  assert.equal(tasks(t.typed).length, 1);
  await t.runner().restore();
  assert.equal(tasks(t.typed).length, 1);
});

crashTest("a Start without a task owes none after a crash", async (t) => {
  t.w.crashAtHeadCall = 3; // the second delivery test: a Start without a task has no fourth call
  await assert.rejects(t.runner().start("game", "ux-review"), Crash);
  t.w.crashAtHeadCall = Infinity;
  await t.runner().restore();
  assert.equal(t.typed.filter((m) => !m.text.includes("Delivery test")).length, 0);
});

crashTest("the task owed after a crash waits in the inbox when the lead's pane is not ready yet", async (t) => {
  t.w.crashAtHeadCall = 4;
  await assert.rejects(t.runner().start("game", "ux-review", { text: "write the solver" }), Crash);
  t.w.crashAtHeadCall = Infinity;
  t.w.held = { "pane-l": "is not running" };
  const runner = t.runner();
  await runner.restore();
  assert.equal(tasks(t.typed).length, 0);
  assert.equal((await t.store.unread("lead")).filter((m) => m.from === "user").length, 1, "kept for the redelivery");
  t.w.held = {};
  await runner.redeliverWaiting();
  assert.equal(tasks(t.typed).length, 1);
  await runner.restore();
  assert.equal(tasks(t.typed).length, 1);
  assert.equal((await t.store.unread("lead")).length, 0);
});

crashTest("a paused team keeps its owed task until Resume, then types it", async (t) => {
  t.w.crashAtHeadCall = 4;
  await assert.rejects(t.runner().start("game", "ux-review", { text: "write the solver" }), Crash);
  t.w.crashAtHeadCall = Infinity;
  await t.store.setPaused(true);
  const runner = t.runner();
  await runner.restore();
  assert.equal(tasks(t.typed).length, 0, "paused: nothing is typed");
  await runner.resume("game", "ux-review");
  assert.equal(tasks(t.typed).length, 1);
});
