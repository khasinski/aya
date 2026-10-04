// An answer to the lead's rounds is any message from the lead (an "ok" too: it read its rounds) or a change to the repo.
// One cadence "minute" lasts 3 s here: the rhythm (1 min) is 3 s, the silence 90 s, the stall 180 s.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-round-brake-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");
const { HOLD_APPROVAL, HOLD_BUSY } = await import("../dist-electron/pane-holds.js");
const { livenessLine } = await import("../dist-test/team-view.js");
const { SILENCE_FIRST_MS, SILENCE_REPEAT_MS, STALL_AFTER_MS } = await import("../dist-electron/team-times.js");

const S = 1000;
const BEAT = TEST_TEAM_MINUTE_MS / S; // seconds: "every 1 min"
const SILENCE = SILENCE_FIRST_MS / S;
const REPEAT = SILENCE_REPEAT_MS / S;
const T = STALL_AFTER_MS / S; // seconds: the stall limit

const TEAM = ({ cadence = true, lead = "tester" } = {}) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
${lead}
${cadence ? `\n## Cadence\n${lead} every 1 min\n` : ""}`;

async function world(opts = {}) {
  for (const pane of ["pane-t", "pane-i"]) recordAgentStatus(pane, "clear", 0);
  const { teamHome, project, cleanup } = teamProject("aya-round-brake-", { teamFile: TEAM(opts), tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: {}, busy: new Set(), commit: "c0", tree: "t0", typed: [], jobs: [], now: Date.parse("2026-10-02T10:00:00Z") };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text, at: w.now }),
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
    treeState: async () => w.tree,
    busy: async (pane) => w.busy.has(pane),
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
  const looks = async (n, seconds = BEAT) => {
    for (let i = 0; i < n; i++) await look(seconds);
  };
  const rounds = () => w.typed.filter((t) => t.pane === "pane-t" && /\| from aya \|/.test(t.text)).flatMap((t) => t.text.match(/Aya round (\d+)\b/)?.[1] ?? []).map(Number);
  const held = async () => (await store.log()).filter((m) => m.from === "aya" && /^Aya rounds held: /.test(m.text)).map((m) => m.text);
  const skips = async () => (await store.log()).filter((m) => m.from === "aya" && /^Aya round \d+ skipped: /.test(m.text)).map((m) => m.text);
  const say = (from, to, text) => store.append({ from, to, commit: null, text, delivered: true, time: new Date(w.now).toISOString() });
  const live = () => teamLiveness(store, ["tester", "implementer"], w.deps.holdReason, { cadence: opts.cadence === false ? null : 1, lead: true }, w.now);
  const restart = () => (make(), w.runner.restore());
  const save = (definition) => (writeFileSync(join(teamHome, "teams", "game", "ux-review", "saved.md"), definition), w.runner.refresh("game", "ux-review"));
  return { w, store, look, looks, rounds, held, skips, say, live, restart, save, cleanup: () => (w.runner.stopAll(), cleanup()) };
}

const brakeTest = (name, ...args) => {
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

brakeTest("a lead that does not answer gets three rounds, then none until it answers; the hold is logged once", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(10);
  assert.deepEqual(t.rounds(), [1, 2, 3], "three rounds, then quiet");
  assert.deepEqual(await t.held(), ["Aya rounds held: tester did not answer Aya rounds 1..3"], "one line, however many looks");
  assert.deepEqual(await t.skips(), [], "no skipped line per held round");
  assert.notEqual((await t.live()).status, "stalled", "the brake is no stall");
});

// [what answers the lead's rounds, how]
const ANSWERS = [
  ["a message from the lead", (t) => t.say("tester", "implementer", "please rerun the solver with the fix")],
  ["a new commit", (t) => void (t.w.commit = "c1")],
  ["a change to the working tree", (t) => void (t.w.tree = "t1")],
  ['an "ok" from the lead', (t) => t.say("tester", "implementer", "ok")],
];
for (const [label, answer] of ANSWERS) {
  brakeTest(`an answer brings the rounds back at once, and three more unanswered hold them again | ${label}`, async (t) => {
    await t.w.runner.start("game", "ux-review");
    await t.looks(6);
    assert.deepEqual(t.rounds(), [1, 2, 3]);
    await answer(t);
    await t.look(1);
    assert.deepEqual(t.rounds(), [1, 2, 3, 4], "the held round goes at the next look");
    await t.looks(10);
    assert.deepEqual(t.rounds(), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await t.held(), ["Aya rounds held: tester did not answer Aya rounds 1..3", "Aya rounds held: tester did not answer Aya rounds 4..6"]);
  });
}

// [what is not an answer, how]
const NOT_ANSWERS = [
  ["a message from another role", (t) => t.say("implementer", "tester", "report: still measuring the solver")],
  ["a HEAD the team already had", (t) => void (t.w.commit = "c0")],
];
for (const [label, act] of NOT_ANSWERS) {
  brakeTest(`not an answer: the rounds stay held | ${label}`, async (t) => {
    await t.w.runner.start("game", "ux-review");
    t.w.commit = "c1"; // seen at the first look, before round 1: the team has had c0 and c1
    await t.looks(6);
    assert.deepEqual(t.rounds(), [1, 2, 3]);
    await act(t);
    await t.looks(5);
    assert.deepEqual(t.rounds(), [1, 2, 3]);
  });
}

brakeTest("an answer before the third round starts the count over: rounds in a row, not in all", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(2);
  assert.deepEqual(t.rounds(), [1, 2]);
  await t.say("tester", "implementer", "split the solver work in two");
  await t.looks(10);
  assert.deepEqual(t.rounds(), [1, 2, 3, 4, 5]);
  assert.deepEqual(await t.held(), ["Aya rounds held: tester did not answer Aya rounds 3..5"]);
});

brakeTest("a round the lead's pane did not take (busy) is not one it failed to answer", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(2);
  t.w.busy.add("pane-t");
  await t.looks(5);
  t.w.busy.delete("pane-t");
  await t.looks(5);
  assert.deepEqual(t.rounds(), [1, 2, 3]);
  assert.ok((await t.skips()).includes(`Aya round 3 skipped: ${HOLD_BUSY}`), "the busy look skipped round 3, it did not count it");
});

brakeTest("the silence's rounds are held too: a team without a rhythm", { cadence: false }, async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.look(SILENCE);
  await t.looks(2, REPEAT);
  assert.deepEqual(t.rounds(), [1, 2, 3], "rounds at 90, 120 and 150 s");
  // A relaunch starts the silence and the stall clock over (not the brake), so the next silence round is due before a stall.
  await t.look(10);
  await t.restart();
  await t.looks(8, 12);
  assert.deepEqual(t.rounds(), [1, 2, 3], "no silence round 90 s after the relaunch");
  assert.deepEqual(await t.held(), ["Aya rounds held: tester did not answer Aya rounds 1..3"]);
  await t.say("tester", "implementer", "reviewer, the fix is in, please check");
  await t.look(SILENCE);
  assert.deepEqual(t.rounds(), [1, 2, 3, 4], "after the answer rounds go again");
});

brakeTest("stalled runs on its own: a held team is stalled after 60 min without a change, and its one round still goes", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(6);
  await t.look(T);
  const live = await t.live();
  assert.equal(live.status, "stalled");
  assert.deepEqual(t.rounds(), [1, 2, 3, 4]);
  assert.match(t.w.typed.at(-1).text, /Aya round 4: stalled: no change to the repo/, "the stall's round is no round on the rhythm");
  await t.looks(6);
  assert.deepEqual(t.rounds(), [1, 2, 3, 4], "and nothing after it");
});

brakeTest("the brake survives a relaunch: still held, the line not repeated", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(6);
  await t.restart();
  await t.looks(6);
  assert.deepEqual(t.rounds(), [1, 2, 3]);
  assert.deepEqual(await t.held(), ["Aya rounds held: tester did not answer Aya rounds 1..3"]);
});

test("a Resume or a Start ends the brake", async () => {
  for (const restart of ["resume", "start"]) {
    const t = await world();
    try {
      await t.w.runner.start("game", "ux-review");
      await t.looks(6);
      await t.w.runner.pause("game", "ux-review");
      await t.w.runner[restart]("game", "ux-review");
      await t.looks(1);
      assert.deepEqual(t.rounds(), [1, 2, 3, 4], restart);
    } finally {
      t.cleanup();
    }
  }
});

brakeTest("the window says, in a few words, that rounds wait for the lead's answer, and stops once it answered", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(2);
  assert.equal((await t.live()).roundsHeld ?? null, null);
  await t.looks(4);
  const live = await t.live();
  assert.deepEqual(live.roundsHeld, { role: "tester", rounds: 3 });
  assert.match(livenessLine(live).text, /^progressing - Aya rounds wait for tester to answer \(3 unanswered\); flagged after 60 min/);
  await t.say("implementer", "tester", "report: still measuring the solver");
  await t.look(1);
  assert.match(livenessLine(await t.live()).text, /^talking - .*; Aya rounds wait for tester to answer \(3 unanswered\)/, "while the others talk");
  await t.w.runner.pause("game", "ux-review");
  assert.equal((await t.live()).roundsHeld, null, "a paused team shows no hold");
  await t.w.runner.start("game", "ux-review");
  await t.say("tester", "implementer", "take the second half of the solver");
  await t.look(BEAT);
  assert.equal((await t.live()).roundsHeld ?? null, null);
  assert.doesNotMatch(livenessLine(await t.live()).text, /rounds wait/);
});

brakeTest("a Save that makes another role the lead: its rounds go, the old lead's unanswered ones are not its own", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(6);
  assert.deepEqual(t.rounds(), [1, 2, 3]);
  await t.save(TEAM({ lead: "implementer" }));
  await t.looks(2);
  const toImplementer = t.w.typed.filter((m) => m.pane === "pane-i" && /Aya round \d+:/.test(m.text));
  assert.equal(toImplementer.length, 2, "the new lead gets the rounds on the rhythm");
  assert.equal((await t.live()).roundsHeld ?? null, null);
});

brakeTest("a hold after a stall that ended without an answer names every unanswered round, the stall's too", async (t) => {
  await t.w.runner.start("game", "ux-review");
  await t.looks(6);
  await t.look(T);
  assert.deepEqual(t.rounds(), [1, 2, 3, 4], "round 4 told the lead of the stall");
  // The user answers a screen the implementer sat on: both clocks start over (no answer from the lead).
  t.w.holds["pane-i"] = HOLD_APPROVAL;
  await t.look(1);
  await t.look(121);
  delete t.w.holds["pane-i"];
  await t.looks(3);
  assert.notEqual((await t.live()).status, "stalled");
  assert.deepEqual(t.rounds(), [1, 2, 3, 4]);
  assert.deepEqual(await t.held(), ["Aya rounds held: tester did not answer Aya rounds 1..3", "Aya rounds held: tester did not answer Aya rounds 1..4"]);
});

test("the brake waits after three unanswered rounds: specs that count with UNANSWERED_ROUNDS hold it here", async () => {
  const { UNANSWERED_ROUNDS } = await import("../dist-electron/team-progress.js");
  assert.equal(UNANSWERED_ROUNDS, 3);
});
