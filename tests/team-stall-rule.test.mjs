// A team is stalled when its repo has not changed for STALL_AFTER, whatever the rounds did.
// One cadence "minute" lasts 3 s here: the rhythm (1 min) is 3 s, the silence 90 s, the stall 180 s.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-stall-rule-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");
const { HOLD_APPROVAL } = await import("../dist-electron/pane-holds.js");
const { STALL_AFTER_MS } = await import("../dist-electron/team-times.js");

const S = 1000;
const BEAT = TEST_TEAM_MINUTE_MS / S;
const T = STALL_AFTER_MS / S;
const ROLES = ["tester", "implementer"];

const TEAM = ({ cadence = true, lead = true } = {}) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report
${lead ? "\n## Lead\ntester\n" : ""}${cadence ? "\n## Cadence\ntester every 1 min\n" : ""}`;

async function world(opts = {}) {
  for (const pane of ["pane-t", "pane-i"]) recordAgentStatus(pane, "clear", 0);
  const { teamHome, project, cleanup } = teamProject("aya-stall-rule-", { teamFile: TEAM(opts), tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: {}, commit: "c0", typed: [], jobs: [], now: Date.parse("2026-10-02T10:00:00Z") };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text, at: w.now }),
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
    busy: async () => false,
  };
  const make = () => {
    w.jobs.length = 0;
    w.runner = new TeamRunner(w.deps, (fn) => (w.jobs.push(fn), () => {}), () => w.now, () => {});
  };
  make();
  const look = async (seconds = 0) => {
    w.now += seconds * S;
    await w.jobs.at(-1)?.();
  };
  const live = () => teamLiveness(store, ROLES, w.deps.holdReason, { cadence: opts.cadence === false ? null : 1, lead: opts.lead !== false }, w.now);
  const rounds = () => w.typed.filter((t) => t.pane === "pane-t" && /\| from aya \|/.test(t.text)).flatMap((t) => t.text.match(/Aya round (\d+):/)?.[1] ?? []).map(Number);
  const restart = () => (make(), w.runner.restore());
  return { w, store, look, live, rounds, restart, cleanup: () => (w.runner.stopAll(), cleanup()) };
}

const stallTest = (name, ...args) => {
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

stallTest("rounds nobody answers do not stall a team: only the repo does", async (t) => {
  await t.w.runner.start("game", "ux-review");
  for (let i = 0; i < 6; i++) await t.look(BEAT);
  assert.deepEqual(t.rounds(), [1, 2, 3], "a round every beat until the brake");
  assert.notEqual((await t.live()).status, "stalled");
  await t.look(T - 6 * BEAT);
  const live = await t.live();
  assert.equal(live.status, "stalled");
  assert.notEqual(live.stalledSince, null, "stalled on the repo");
});

stallTest("HEAD going back to a commit the team already had is no change to the repo", async (t) => {
  t.w.commit = "c1";
  await t.w.runner.start("game", "ux-review");
  await t.look(BEAT);
  t.w.commit = "c2";
  await t.look(BEAT);
  const moved = (await t.live()).repo.since;
  assert.equal(Date.parse(moved), t.w.now, "a new commit is a change");
  for (const back of ["c1", "c2", "c1"]) {
    t.w.commit = back;
    await t.look(BEAT);
  }
  assert.equal((await t.live()).repo.since, moved, "checking out c1, c2 and c1 again changed nothing");
  t.w.commit = "c3";
  await t.look(BEAT);
  assert.equal(Date.parse((await t.live()).repo.since), t.w.now, "a commit nobody had before is a change again");
});

stallTest("the HEADs a team had stay known across a Pause and Resume", async (t) => {
  t.w.commit = "c1";
  await t.w.runner.start("game", "ux-review");
  await t.look(BEAT);
  t.w.commit = "c2";
  await t.look(BEAT);
  await t.w.runner.pause("game", "ux-review");
  await t.w.runner.resume("game", "ux-review");
  const resumed = (await t.live()).repo.since;
  t.w.commit = "c1";
  await t.look(BEAT);
  assert.equal((await t.live()).repo.since, resumed, "going back to c1 after the Resume is no change either");
});

stallTest("the window only reads: asking for the liveness writes nothing, a commit is seen at the clock's next look", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.look(T + 1);
  assert.equal((await t.live()).status, "stalled");
  const file = join(t.store.dir, "progress.json");
  const before = readFileSync(file, "utf-8");
  t.w.commit = "c9";
  t.w.holds["pane-i"] = HOLD_APPROVAL;
  for (let i = 0; i < 3; i++) await t.live();
  assert.equal(readFileSync(file, "utf-8"), before, "progress.json is the clock's alone");
  assert.equal((await t.live()).status, "stalled", "nothing seen yet");
  await t.look(BEAT);
  assert.notEqual((await t.live()).status, "stalled", "the next look saw the commit");
});

stallTest("a team with no lead is still watched: its clock records the repo, though it never gets a round", { cadence: false, lead: false }, async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.look(T - 10);
  t.w.commit = "c1";
  await t.look(BEAT);
  await t.look(20);
  assert.equal((await t.live()).status, "progressing", "the commit at T-10 s restarted the stall clock");
  assert.deepEqual(t.rounds(), []);
});

stallTest("a stall survives a relaunch: still stalled, since the same time, and the lead is not told twice", async (t) => {
  await t.w.runner.start("game", "ux-review");
  for (let s = 0; s <= T; s += BEAT) await t.look(BEAT);
  const before = await t.live();
  assert.equal(before.status, "stalled");
  const told = t.w.typed.filter((m) => /stalled: no change to the repo/.test(m.text)).length;
  assert.equal(told, 1);
  t.w.now += 600 * S;
  await t.restart();
  for (let i = 0; i < 5; i++) await t.look(BEAT);
  const after = await t.live();
  assert.equal(after.status, "stalled", "a relaunch does not hide the stall");
  assert.equal(after.stalledSince, before.stalledSince, "and its time is still the last change to the repo");
  assert.equal(t.w.typed.filter((m) => /stalled: no change to the repo/.test(m.text)).length, told, "told once per stall");
  t.w.commit = "c1";
  await t.look(BEAT);
  assert.notEqual((await t.live()).status, "stalled", "a change ends it after the relaunch too");
});

stallTest("the round due at a stall names who waits on whom: no message of its own carries it", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.store.append({ from: "implementer", to: "tester", commit: null, text: "report: the timer test fails on CI", delivered: true, time: new Date(t.w.now).toISOString() });
  for (let s = 0; s <= T; s += BEAT) await t.look(BEAT);
  const stalled = t.w.typed.filter((m) => /stalled: no change to the repo/.test(m.text));
  assert.equal(stalled.length, 1);
  assert.match(stalled[0].text, /Aya round \d+: stalled: no change to the repo since \d\d:\d\d \(1 message\)\. Unanswered: implementer waits for tester since \d\d:\d\d/);
});
