// One round clock per team: rounds fall due on the rhythm, the silence or a stall, one at a time.
// One cadence "minute" lasts 3 s here: the rhythm (1 min) is 3 s, the silence 90 s, the stall 180 s.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-round-clock-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { teamLiveness } = await import("../dist-electron/team-progress.js");
const { listTeams } = await import("../dist-electron/team-admin.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");
const { HOLD_BUSY, HOLD_DRAFT, HOLD_NOT_RUNNING } = await import("../dist-electron/pane-holds.js");
const { livenessLine } = await import("../dist-test/team-view.js");
const { STALL_AFTER_MS } = await import("../dist-electron/team-times.js");

const S = 1000;
const BEAT = TEST_TEAM_MINUTE_MS / S; // seconds: "every 1 min"
const T = STALL_AFTER_MS / S; // seconds: the stall limit

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
  const { teamHome, project, cleanup } = teamProject("aya-round-clock-", { teamFile: TEAM(opts), tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: {}, busy: new Set(), commit: "c0", typed: [], jobs: [], now: Date.parse("2026-10-02T10:00:00Z"), gate: null };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text, at: w.now }),
    holdReason: async (pane) => {
      if (w.gate && pane === "pane-t") await w.gate(pane);
      return w.holds[pane] ?? null;
    },
    headCommit: async () => w.commit,
    busy: async (pane) => w.busy.has(pane),
  };
  const track = (fn, ms, firstMs = ms) => {
    const job = { fn, ms, firstMs, cancelled: false };
    w.jobs.push(job);
    return () => (job.cancelled = true);
  };
  w.runner = new TeamRunner(w.deps, track, () => w.now, () => {});
  const check = async () => {
    for (const job of w.jobs.filter((j) => !j.cancelled)) await job.fn();
  };
  const toLead = () => w.typed.filter((t) => t.pane === "pane-t" && /\| from aya \|/.test(t.text) && !/Delivery test/.test(t.text));
  const skips = async () => (await store.log()).filter((m) => m.from === "aya" && /^round \d+ skipped: /.test(m.text)).map((m) => m.text);
  const talk = () => store.append({ from: "implementer", to: "tester", commit: null, text: "report: still measuring the solver", delivered: true, time: new Date(w.now).toISOString() });
  return { w, store, check, toLead, skips, talk, cleanup: () => (w.runner.stopAll(), cleanup()) };
}

const clockTest = (name, ...args) => {
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

test("one clock per team: Start arms one timer, whether the team has a rhythm, a lead, or both", async () => {
  for (const opts of [{ cadence: true, lead: true }, { cadence: false, lead: true }, { cadence: true, lead: false }]) {
    const t = await world(opts);
    try {
      await t.w.runner.start("game", "ux-review");
      assert.equal(t.w.jobs.filter((j) => !j.cancelled).length, 1, JSON.stringify(opts));
    } finally {
      t.cleanup();
    }
  }
});

// [why the due round is not typed, how, the reason the log gives]
const SKIPS = [
  ["the lead is busy", (t) => t.w.busy.add("pane-t"), HOLD_BUSY],
  ["a draft in the lead's composer", (t) => void (t.w.holds["pane-t"] = HOLD_DRAFT), HOLD_DRAFT],
  ["the lead's pane is not running", (t) => void (t.w.holds["pane-t"] = HOLD_NOT_RUNNING), HOLD_NOT_RUNNING],
  ["the lead asked the user (aya status waiting)", (t) => recordAgentStatus("pane-t", "waiting", t.w.now, "need the staging password"), "tester asked the user: need the staging password"],
];
for (const [label, cause, reason] of SKIPS) {
  clockTest(`a due round that is not typed is logged once as skipped | ${label}`, async (t) => {
    await t.w.runner.start("game", "ux-review");
    t.w.now += S;
    await cause(t);
    t.w.now += BEAT * S;
    await t.check();
    await t.check();
    assert.deepEqual(t.toLead(), [], "nothing typed");
    assert.deepEqual(await t.skips(), [`round 1 skipped: ${reason}`], "one line, however many checks");
  });
}

clockTest("a due round is logged as skipped when the team is paused while it is prepared", async (t) => {
  await t.w.runner.start("game", "ux-review");
  t.w.now += BEAT * S + S;
  t.w.gate = async () => {
    t.w.gate = null;
    await t.w.runner.pause("game", "ux-review");
  };
  await t.check();
  assert.deepEqual(t.toLead(), []);
  assert.deepEqual(await t.skips(), ["round 1 skipped: the team is paused"]);
});

clockTest("a stalled team: the round due at the stall says so, the rounds after it are skipped and logged once", async (t) => {
  await t.w.runner.start("game", "ux-review");
  // The implementer talks every beat (not the lead, so its rounds go unanswered) and the repo never changes.
  for (let s = 0; s <= T; s += BEAT) {
    t.w.now += BEAT * S;
    await t.talk();
    await t.check();
  }
  const stalledRounds = t.toLead().filter((r) => /stalled: no change to the repo/.test(r.text));
  assert.equal(stalledRounds.length, 1, "the lead is told once");
  const typed = t.toLead().length;
  for (let i = 0; i < 5; i++) {
    t.w.now += BEAT * S;
    await t.talk();
    await t.check();
  }
  assert.equal(t.toLead().length, typed, "no round while stalled");
  const skipped = await t.skips();
  assert.equal(skipped.length, 1, skipped.join("\n"));
  assert.match(skipped[0], new RegExp(`^round ${typed + 1} skipped: stalled: no change to the repo since \\d\\d:\\d\\d`));
});

test("a round whose Enter did not go through is logged as left in the composer and keeps its number", async () => {
  const { TextPastedError } = await import("../dist-electron/team-control.js");
  const t = await world();
  try {
    await t.w.runner.start("game", "ux-review");
    t.w.deps.deliver = async (pane, text) => {
      if (/Round 1:/.test(text)) throw new TextPastedError("enter failed");
    };
    t.w.now += BEAT * S;
    await t.check();
    const entry = (await t.store.log()).filter((m) => m.from === "aya" && /^Round 1:/.test(m.text)).at(-1);
    assert.equal(entry.typedOnly, true, "the log says it sits in the composer");
    assert.equal(await t.store.lastRound(), 0, "a round that was not submitted does not use up a number");
    assert.deepEqual(await t.skips(), [], "it is not a skipped round: its text is there");
  } finally {
    t.cleanup();
  }
});

// A crash at the round's write leaves its number and every clock where they were.
const TRIGGERS = [
  ["the rhythm", { cadence: true }, BEAT + 1],
  ["the silence (no rhythm)", { cadence: false }, 91],
];
for (const [label, opts, after] of TRIGGERS) {
  test(`one write for a round's number and clocks | ${label}`, async () => {
    const t = await world(opts);
    const proto = TeamStore.prototype;
    const saved = { recordRound: proto.recordRound };
    try {
      await t.w.runner.start("game", "ux-review");
      const before = { round: await t.store.lastRound(), clock: await t.store.roundClockAt(), silence: await t.store.silenceRoundAt() };
      proto.recordRound = async () => {
        throw new Error("crash");
      };
      t.w.now += after * S;
      await t.check();
      assert.equal(t.toLead().length, 1, "the round was typed");
      assert.deepEqual({ round: await t.store.lastRound(), clock: await t.store.roundClockAt(), silence: await t.store.silenceRoundAt() }, before);
    } finally {
      Object.assign(proto, saved);
      t.cleanup();
    }
  });
}

clockTest("the window's words follow the rhythm: a 1 min cadence is 'a round every 1 min', not 'after 30 min'", async (t) => {
  t.w.now = Date.now();
  await t.w.runner.start("game", "ux-review");
  const [team] = await listTeams(t.w.deps.teamHome, (await t.w.deps.listProjects())[0], t.w.deps.holdReason);
  const line = livenessLine(team.liveness).text;
  assert.match(line, /the lead gets a round every 1 min/);
  assert.doesNotMatch(line, /after 30 min/);
  const quiet = await world({ cadence: false });
  try {
    quiet.w.now = Date.now();
    await quiet.w.runner.start("game", "ux-review");
    const [q] = await listTeams(quiet.w.deps.teamHome, (await quiet.w.deps.listProjects())[0], quiet.w.deps.holdReason);
    assert.match(livenessLine(q.liveness).text, /the lead is asked for a round after 30 min/);
  } finally {
    quiet.cleanup();
  }
});

clockTest("teamLiveness needs no clock of its own to say the rhythm", async (t) => {
  await t.w.runner.start("game", "ux-review");
  const live = await teamLiveness(t.store, ["tester", "implementer"], t.w.deps.holdReason, { cadence: 1, lead: true }, t.w.now);
  assert.equal(live.silence.everyMin, 1);
});

test("a silence round leaves the rhythm's clock alone", async () => {
  const t = await world({ cadence: false });
  try {
    await t.w.runner.start("game", "ux-review");
    t.w.now += 91 * S;
    await t.check();
    assert.equal(t.toLead().length, 1, "the silence round was typed");
    assert.equal(await t.store.roundClockAt(), null);
    assert.notEqual(await t.store.silenceRoundAt(), null);
  } finally {
    t.cleanup();
  }
});
