// Start team (delivery test), Aya-owned rounds and the team pause (D15, D20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { ROUND_CHECK_MS } = await import("../dist-electron/team-times.js");
const { TEAM_REDELIVERY_MS } = await import("../dist-electron/team-ipc.js");
const { TEAM_MINUTE_MS } = await import("../dist-electron/paths.js");
const CADENCE_MS = 30 * TEAM_MINUTE_MS;
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");

const TEAM = (cadence) => `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report
${cadence ? "\n## Cadence\ntester every 30 min\n" : ""}`;

async function setup({ cadence = true, held = {} } = {}) {
  const { teamHome, project, cleanup } = teamProject("aya-runner-", { teamFile: TEAM(cadence) });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const typed = [];
  const scheduled = [];
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async (pane) => held[pane] ?? null,
    headCommit: async () => null,
  };
  const t = { now: Date.parse("2026-10-02T10:00:00Z") };
  const runner = new TeamRunner(deps, (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    scheduled.push(job);
    return () => (job.cancelled = true);
  }, () => t.now);
  // A round goes when a look of the clock finds it due, so the fake clock moves first.
  const beat = (job = scheduled.at(-1), ms = CADENCE_MS) => ((t.now += ms), job.fn());
  return Object.assign(t, { runner, typed, scheduled, store, deps, project, beat, cleanup });
}

const runnerTest = (name, ...args) => {
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

runnerTest("start sends every role a delivery test that names its peer", { cadence: false }, async (t) => {
  const result = await t.runner.start("game", "ux-review");
  assert.equal(result.started, true);
  assert.deepEqual(result.delivered.sort(), ["implementer", "tester"]);
  const toTester = t.typed.find((w) => w.pane === "pane-t").text;
  assert.match(toTester, /^\[team ux-review \| from aya \| \d\d:\d\d\]/);
  assert.match(toTester, /aya team whoami/);
  assert.match(toTester, /aya team send implementer/);
  // Every running team has a clock (it records the repo for the window); this one types no round.
  assert.equal(t.scheduled.length, 1);
  t.typed.length = 0;
  await t.beat();
  assert.deepEqual(t.typed, [], "no lead, no round");
});

runnerTest("Start lists every role that is not ready, including one with no pane", { cadence: false, held: { "pane-t": "is not running" } }, async (t) => {
  await t.store.releasePane("pane-i");
  const result = await t.runner.start("game", "ux-review");
  assert.equal(result.started, false);
  assert.deepEqual(result.held, [
    { role: "tester", reason: "is not running" },
    { role: "implementer", reason: "no pane assigned" },
  ]);
});

test("a team saved with a role named user before it was reserved starts, but takes no task", async () => {
  const LEGACY = `# ux-review

## Role: user
Sends to: implementer
Must not: edit code

## Role: implementer
Sends to: user
Must not: skip a report

## Cadence
user every 30 min
`;
  const { teamHome, project, cleanup } = teamProject("aya-runner-legacy-", { teamFile: LEGACY, tabs: [{ id: "pane-u" }, { id: "pane-i" }] });
  try {
    const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
    await store.assign("user", "pane-u");
    await store.assign("implementer", "pane-i");
    const typed = [];
    const deps = {
      teamHome,
      listProjects: async () => [project],
      deliver: async (pane, text) => void typed.push({ pane, text }),
      holdReason: async () => null,
      headCommit: async () => null,
    };
    const runner = new TeamRunner(deps, () => () => {});
    await assert.rejects(runner.start("game", "ux-review", { text: "fix the timer" }), {
      message: 'team ux-review has a role named "user", the sender of a Start task; start it without a task, or rename the role to give one; nothing was started',
    });
    assert.equal(typed.length, 0);
    assert.equal((await store.state()).running, false);
    const result = await runner.start("game", "ux-review");
    assert.deepEqual(result.delivered.sort(), ["implementer", "user"]);
    assert.match(typed.find((w) => w.pane === "pane-u").text, /aya team send implementer/);
    // The role still sends by name, as before the upgrade.
    const sent = await handleTeamRequest({ type: "team-send", role: "implementer", text: "done" }, "pane-u", deps);
    assert.match(sent.output, /implementer/);
    assert.match(typed.at(-1).text, /^\[team ux-review \| from user \|/);
  } finally {
    cleanup();
  }
});

runnerTest("rounds go to the cadence role on its interval and are numbered", async (t) => {
  await t.runner.start("game", "ux-review");
  assert.equal(t.scheduled.length, 1);
  assert.equal(t.scheduled[0].ms, ROUND_CHECK_MS, "one clock that looks every check");
  t.typed.length = 0;
  await t.beat(t.scheduled[0], CADENCE_MS - 1);
  assert.deepEqual(t.typed, [], "not before the cadence");
  await t.beat(t.scheduled[0], 1);
  await t.beat(t.scheduled[0]);
  assert.deepEqual(t.typed.map((w) => w.pane), ["pane-t", "pane-t"]);
  assert.match(t.typed[0].text, /round 1/i);
  assert.match(t.typed[1].text, /round 2/i);
});

runnerTest("pause stops rounds and team sends; resume brings both back", async (t) => {
  await t.runner.start("game", "ux-review");
  await t.runner.pause("game", "ux-review");
  assert.equal(t.scheduled[0].cancelled, true);
  await assert.rejects(
    handleTeamRequest({ type: "team-send", role: "implementer", text: "x" }, "pane-t", t.deps),
    /ux-review is paused/,
  );
  await t.runner.resume("game", "ux-review");
  assert.equal(t.scheduled.length, 2);
  t.typed.length = 0;
  await handleTeamRequest({ type: "team-send", role: "implementer", text: "x" }, "pane-t", t.deps);
  assert.equal(t.typed.length, 1);
});

runnerTest("Start team after a pause takes messages again", { cadence: false }, async (t) => {
  await t.runner.pause("game", "ux-review");
  await t.runner.start("game", "ux-review");
  t.typed.length = 0;
  await handleTeamRequest({ type: "team-send", role: "implementer", text: "x" }, "pane-t", t.deps);
  assert.equal(t.typed.length, 1);
});

runnerTest("Start with a pane that refuses the text reports it and still arms the rounds", async (t) => {
  t.deps.deliver = async (pane) => {
    if (pane === "pane-i") throw new Error("pane did not accept the text");
  };
  const result = await t.runner.start("game", "ux-review");
  assert.deepEqual(result.held, [{ role: "implementer", reason: "did not take the text (it may have exited)" }]);
  assert.equal(t.scheduled.length, 1);
  assert.equal((await t.store.unread("implementer")).length, 1);
});

runnerTest("restore skips a running team whose file does not parse and re-arms the others", async (t) => {
  const project = (await t.deps.listProjects())[0];
  writeFileSync(join(project.directory, ".aya", "teams", "alpha.md"), "# alpha\n\n## Role: solo\n");
  await new TeamStore(teamDir(t.deps.teamHome, "game", "alpha")).setPaused(false);
  await t.store.setPaused(false);
  await t.runner.restore();
  assert.deepEqual(t.scheduled.map((job) => job.ms), [ROUND_CHECK_MS], "ux-review only");
});

runnerTest("saving a running team re-arms its rounds from the new definition", async (t) => {
  await t.runner.start("game", "ux-review");
  await t.store.saveDefinition(TEAM(true).replace("tester every 30 min", "implementer every 5 min"));
  await t.runner.refresh("game", "ux-review");
  assert.equal(t.scheduled[0].cancelled, true);
  t.typed.length = 0;
  await t.beat(t.scheduled.at(-1), 5 * 60 * 1000);
  assert.deepEqual(t.typed.map((w) => w.pane), ["pane-i"], "the new cadence role, at its 5 min");
});

runnerTest("a round tick never rejects: a closed project or a failing pane only skips the round", async (t) => {
  await t.runner.start("game", "ux-review");
  t.deps.listProjects = async () => [];
  await t.beat();
  t.deps.listProjects = async () => [{ slug: "game", name: "game", directory: "/nonexistent", tabs: [] }];
  t.deps.deliver = async () => {
    throw new Error("pane gone");
  };
  await t.scheduled[0].fn();
});

runnerTest("Aya's messages carry the commit in the header, as the log does", async (t) => {
  t.deps.headCommit = async () => "abc1234";
  await t.runner.start("game", "ux-review");
  assert.match(t.typed[0].text, /^\[team ux-review \| from aya \| \d\d:\d\d \| abc1234\] Delivery test/);
  assert.equal((await t.store.log()).at(-1).commit, "abc1234");
});

runnerTest("a role given to a pane in a running team is introduced at once, as Start would", { cadence: false }, async (t) => {
  assert.equal(await t.runner.introduce("game", "ux-review", "implementer"), null);
  assert.equal(t.typed.length, 0, "before Start, Start tells it");
  await t.runner.start("game", "ux-review");
  t.typed.length = 0;
  assert.equal(await t.runner.introduce("game", "ux-review", "implementer"), null);
  assert.deepEqual(t.typed.map((w) => w.pane), ["pane-i"]);
  assert.match(t.typed[0].text, /Delivery test: run aya team whoami, then send one word to tester/);
  assert.match(t.typed[0].text, /run aya capabilities for its current commands/, "a pane briefed before an update learns the new commands here");
  await t.store.setPaused(true);
  assert.equal(await t.runner.introduce("game", "ux-review", "tester"), null);
  assert.equal(t.typed.length, 1);
});

runnerTest("introducing a held pane says why and keeps the message", { cadence: false }, async (t) => {
  await t.runner.start("game", "ux-review");
  t.deps.holdReason = async (pane) => (pane === "pane-t" ? "shows an approval prompt" : null);
  assert.equal(await t.runner.introduce("game", "ux-review", "tester"), "shows an approval prompt");
  assert.equal((await t.store.annotatedLog()).filter((m) => m.to === "tester" && !m.delivered).length, 1);
});

runnerTest("a held message is typed once the receiving pane is free, with its own header and time", { cadence: false }, async (t) => {
  // Never started, not paused: aya team send works, so held messages go out too.
  const waiting = await t.store.append({ from: "tester", to: "implementer", commit: "abc1234", text: "round 3 fixed\nsee test", delivered: false });
  t.deps.holdReason = async (pane) => (pane === "pane-i" ? "shows an approval prompt" : null);
  assert.equal(await t.runner.redeliverWaiting(), 0);
  assert.equal(t.typed.length, 0);
  t.deps.holdReason = async () => null;
  assert.equal(await t.runner.redeliverWaiting(), 1);
  assert.equal(t.typed.length, 1);
  assert.equal(t.typed[0].pane, "pane-i");
  assert.match(t.typed[0].text, /^\[team ux-review \| from tester \| \d\d:\d\d \| abc1234\] round 3 fixed see test$/);
  assert.equal((await t.store.unread("implementer")).length, 0);
  assert.equal(await t.runner.redeliverWaiting(), 0, "typed once");
  assert.ok(waiting.id > 0);
});

runnerTest("overlapping redelivery passes type each held message once", { cadence: false }, async (t) => {
  await t.store.append({ from: "tester", to: "implementer", commit: null, text: "first", delivered: false });
  await t.store.append({ from: "tester", to: "implementer", commit: null, text: "second", delivered: false });
  t.deps.deliver = async (pane, text) => {
    await new Promise((r) => setTimeout(r, 20));
    t.typed.push({ pane, text });
  };
  await Promise.all([t.runner.redeliverWaiting(), t.runner.redeliverWaiting()]);
  assert.deepEqual(t.typed.map((w) => w.text.split("] ")[1]), ["first"]);
  await t.runner.redeliverWaiting();
  assert.deepEqual(t.typed.map((w) => w.text.split("] ")[1]), ["first", "second"]);
  assert.equal((await t.store.unread("implementer")).length, 0);
});


runnerTest("refresh leaves a team that is not running unarmed", async (t) => {
  await t.runner.refresh("game", "ux-review");
  assert.equal(t.scheduled.length, 0);
});

runnerTest("a pane that refuses the first waiting message gets none of the later ones", { cadence: false }, async (t) => {
  await t.store.setPaused(false);
  for (const text of ["first", "second", "third"]) {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text, delivered: false });
  }
  let calls = 0;
  t.deps.deliver = async () => {
    if (++calls === 1) throw new Error("pane gone");
  };
  assert.equal(await t.runner.redeliverWaiting(), 0);
  assert.equal(calls, 1);
  assert.deepEqual((await t.store.unread("implementer")).map((m) => m.text), ["first", "second", "third"]);
});

runnerTest("redelivery types one message per pane per pass, so a prompt it raises can show first", { cadence: false }, async (t) => {
  for (const text of ["first", "second", "third"]) {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text, delivered: false });
  }
  await t.store.append({ from: "implementer", to: "tester", commit: null, text: "back", delivered: false });
  assert.equal(await t.runner.redeliverWaiting(), 2);
  assert.deepEqual(t.typed.map((w) => [w.pane, w.text.split("] ")[1]]), [["pane-t", "back"], ["pane-i", "first"]]);
  assert.deepEqual((await t.store.unread("implementer")).map((m) => m.text), ["second", "third"]);
});

runnerTest("a stray file or a broken team in .aya/teams does not stop the other teams", { cadence: false }, async (t) => {
  const dir = join(t.project.directory, ".aya", "teams");
  writeFileSync(join(dir, "README.md"), "# Our teams\n");
  writeFileSync(join(dir, "My Team.md"), "# My Team\n");
  writeFileSync(join(dir, "aaa-broken.md"), "not a team\n");
  const broken = new TeamStore(teamDir(t.deps.teamHome, "game", "aaa-broken"));
  await broken.saveDefinition("not a team\n");
  await broken.append({ from: "tester", to: "implementer", commit: null, text: "x", delivered: false });
  await t.store.append({ from: "tester", to: "implementer", commit: null, text: "through", delivered: false });
  assert.equal(await t.runner.redeliverWaiting(), 1);
  assert.equal(t.typed[0].text.split("] ")[1], "through");
});

test("a team file nobody saved in Aya reaches no agent", async () => {
  const { teamHome, project, cleanup } = teamProject("aya-runner-", { teamFile: TEAM(true), saved: false });
  try {
    const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
    await store.assign("tester", "pane-t");
    const typed = [];
    const runner = new TeamRunner({
      teamHome,
      listProjects: async () => [project],
      deliver: async (pane, text) => void typed.push({ pane, text }),
      holdReason: async () => null,
      headCommit: async () => null,
    }, () => () => {});
    await assert.rejects(runner.start("game", "ux-review"), /not saved in Aya yet/);
    await assert.rejects(
      handleTeamRequest({ type: "team-whoami" }, "pane-t", { teamHome, listProjects: async () => [project] }),
      /not saved in Aya yet/,
    );
    assert.equal(typed.length, 0);
  } finally {
    cleanup();
  }
});

// arm awaits the round clock: overlapping arms must leave one live schedule, or pause cannot stop the leaked one.
const live = (t) => t.scheduled.filter((job) => !job.cancelled);
const OVERLAPS = {
  "resume + resume": (t) => [t.runner.resume("game", "ux-review"), t.runner.resume("game", "ux-review")],
  "refresh + refresh": (t) => [t.runner.refresh("game", "ux-review"), t.runner.refresh("game", "ux-review")],
  "restore + resume": (t) => [t.runner.restore(), t.runner.resume("game", "ux-review")],
  "restore + refresh": (t) => [t.runner.restore(), t.runner.refresh("game", "ux-review")],
};
for (const [name, overlap] of Object.entries(OVERLAPS)) {
  runnerTest(`overlapping arms | ${name} leave one live schedule and pause stops it`, async (t) => {
    await t.runner.start("game", "ux-review");
    await Promise.all(overlap(t));
    assert.equal(live(t).length, 1);
    await t.runner.pause("game", "ux-review");
    assert.equal(live(t).length, 0);
  });
}

// A team whose held messages cannot be retried must not fill the log every pass.
async function redeliveryLog({ saved, definition } = {}) {
  const { teamHome, project, cleanup } = teamProject("aya-runner-log-", { teamFile: TEAM(false), saved });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("implementer", "pane-i");
  await store.append({ from: "tester", to: "implementer", commit: null, text: "owed", delivered: false });
  if (definition !== undefined) writeFileSync(join(teamHome, "teams", "game", "ux-review", "saved.md"), definition);
  const typed = [];
  const warned = [];
  let clock = 1_000_000;
  const deps = { teamHome, listProjects: async () => [project], deliver: async (pane, text) => void typed.push({ pane, text }), holdReason: async () => null, headCommit: async () => null };
  const runner = new TeamRunner(deps, () => () => {}, () => clock, (...args) => warned.push(args));
  return { runner, store, typed, warned, tick: (ms) => (clock += ms), teamHome, cleanup };
}

test("a team never saved in Aya owes its held messages quietly: no warning, however many passes", async () => {
  const t = await redeliveryLog({ saved: false });
  try {
    for (let i = 0; i < 20; i += 1) {
      assert.equal(await t.runner.redeliverWaiting(), 0);
      t.tick(TEAM_REDELIVERY_MS);
    }
    assert.deepEqual(t.warned, []);
    assert.equal(t.typed.length, 0);
  } finally {
    t.cleanup();
  }
});

test("a saved team that does not parse warns once with its reason and no stack; once fixed, the next pass types", async () => {
  const t = await redeliveryLog({ definition: "not a team\n" });
  try {
    await t.runner.redeliverWaiting();
    assert.equal(t.warned.length, 1);
    assert.ok(t.warned[0].every((arg) => typeof arg === "string"), "a message, not an Error with a stack");
    assert.match(t.warned[0].join(" "), /game\/ux-review/);
    writeFileSync(join(t.teamHome, "teams", "game", "ux-review", "saved.md"), TEAM(false));
    t.tick(1_000);
    assert.equal(await t.runner.redeliverWaiting(), 1, "the fixed team is retried at once; the message is typed once");
    assert.equal(t.typed.length, 1);
    assert.equal(t.warned.length, 1, "a recovery adds no warning");
  } finally {
    t.cleanup();
  }
});

test("the same failure warns once, however many passes fail on it", async () => {
  const t = await redeliveryLog({ definition: "not a team\n" });
  try {
    for (let i = 0; i < 400; i += 1) {
      await t.runner.redeliverWaiting();
      t.tick(TEAM_REDELIVERY_MS);
    }
    assert.equal(t.warned.length, 1, `${t.warned.length} warnings in 100 minutes`);
  } finally {
    t.cleanup();
  }
});

const breakSaved = (t, text) => writeFileSync(join(t.teamHome, "teams", "game", "ux-review", "saved.md"), text);

test("a recovery clears the warning, so the next failure warns at once", async () => {
  const t = await redeliveryLog({ definition: "not a team\n" });
  try {
    await t.runner.redeliverWaiting();
    await t.runner.redeliverWaiting();
    breakSaved(t, TEAM(false));
    assert.equal(await t.runner.redeliverWaiting(), 1);
    const warned = t.warned.length;
    breakSaved(t, "not a team\n");
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "again", delivered: false });
    await t.runner.redeliverWaiting();
    assert.equal(t.warned.length, warned + 1, "the first failure after a recovery is logged");
  } finally {
    t.cleanup();
  }
});

test("a failure with another reason warns again", async () => {
  const t = await redeliveryLog({ definition: "not a team\n" });
  try {
    await t.runner.redeliverWaiting();
    breakSaved(t, "# ux-review\n\n## Role: tester\nSends to: nobody\n");
    await t.runner.redeliverWaiting();
    assert.equal(t.warned.length, 2);
  } finally {
    t.cleanup();
  }
});

for (const [action, run] of [
  ["Save team (refresh)", (t) => t.runner.refresh("game", "ux-review")],
  ["Resume", (t) => t.runner.resume("game", "ux-review")],
]) {
  test(`${action} ends a team's back-off, so the fixed team is retried at once`, async () => {
    const t = await redeliveryLog({ definition: "not a team\n" });
    try {
      await t.runner.redeliverWaiting();
      breakSaved(t, TEAM(false));
      await run(t);
      assert.equal(await t.runner.redeliverWaiting(), 1);
    } finally {
      t.cleanup();
    }
  });
}

const roundTexts = (t) => t.typed.map((w) => w.text.replace(/^.*\] /, "")).filter((x) => x.startsWith("Aya round"));

runnerTest("a Save that lands while a tick is delivering does not repeat the round and does not stop the ones after it", async (t) => {
  await t.runner.start("game", "ux-review");
  let reached;
  const inDeliver = new Promise((resolve) => (reached = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const deliver = t.deps.deliver;
  t.deps.deliver = async (pane, text, ...rest) => {
    if (/Aya round/.test(text)) {
      reached();
      await gate;
    }
    return deliver(pane, text, ...rest);
  };
  const first = t.beat(t.scheduled[0]);
  await inDeliver;
  await t.runner.refresh("game", "ux-review");
  release();
  await first;
  assert.equal(await t.store.lastRound(), 1);
  await t.beat(t.scheduled.at(-1), 0);
  assert.deepEqual(roundTexts(t).length, 1, "the look that finds the round already typed ends");
  await t.beat(t.scheduled.at(-1));
  // 30 min with no progress: the rounds carry the silence's text; their numbers are what this checks.
  assert.deepEqual(roundTexts(t).map((x) => x.slice(0, 12)), ["Aya round 1:", "Aya round 2:"]);
});

runnerTest("a Save during a gated delivery: the tick after it types Aya round N+1 once when that round is already due", async (t) => {
  let clock = Date.now();
  const jobs = [];
  const runner = new TeamRunner(t.deps, (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    jobs.push(job);
    return () => (job.cancelled = true);
  }, () => clock);
  await runner.start("game", "ux-review");
  let reached;
  const inDeliver = new Promise((resolve) => (reached = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const deliver = t.deps.deliver;
  t.deps.deliver = async (pane, text, ...rest) => {
    if (/Aya round/.test(text)) {
      reached();
      await gate;
    }
    return deliver(pane, text, ...rest);
  };
  clock += CADENCE_MS;
  const first = jobs[0].fn();
  await inDeliver;
  await runner.refresh("game", "ux-review");
  release();
  await first;
  assert.equal(await t.store.lastRound(), 1);
  clock += CADENCE_MS;
  await jobs.at(-1).fn();
  assert.deepEqual(roundTexts(t).map((x) => x.slice(0, 11)), ["Aya round 1", "Aya round 2"], "a late timer after the resync still types the due round, once");
  assert.equal(await t.store.lastRound(), 2);
});

runnerTest("Pause during a tick's awaits: no round is typed after it", async (t) => {
  await t.runner.start("game", "ux-review");
  const typedBefore = t.typed.length;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let reached;
  const inTick = new Promise((resolve) => (reached = resolve));
  const hold = t.deps.holdReason;
  t.deps.holdReason = async (pane) => {
    reached();
    await gate;
    return hold(pane);
  };
  const tick = t.beat(t.scheduled[0]);
  await inTick;
  await t.runner.pause("game", "ux-review");
  release();
  await tick;
  assert.equal(t.typed.length, typedBefore, "nothing typed after the pause");
  assert.equal(await t.store.lastRound(), 0);
  assert.deepEqual((await t.store.log()).filter((m) => m.delivered && /^Aya round \d+:/.test(m.text)), [], "no round is logged as typed");
  assert.deepEqual((await t.store.log()).filter((m) => /^Aya round 1 skipped: /.test(m.text)).map((m) => m.text), ["Aya round 1 skipped: the team is paused"]);
  assert.deepEqual((await t.store.log()).filter((m) => m.typedOnly), [], "nothing is logged as sitting in a composer");
  assert.equal((await t.store.state()).paused, true);
});

runnerTest("a Save during a tick's awaits: the old tick types nothing, the new arm types the round once", async (t) => {
  await t.runner.start("game", "ux-review");
  const typedBefore = t.typed.length;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let reached;
  const inTick = new Promise((resolve) => (reached = resolve));
  const hold = t.deps.holdReason;
  let first = true;
  t.deps.holdReason = async (pane) => {
    if (first) {
      first = false;
      reached();
      await gate;
    }
    return hold(pane);
  };
  const oldTick = t.beat(t.scheduled[0]);
  await inTick;
  await t.runner.refresh("game", "ux-review");
  release();
  await oldTick;
  assert.equal(t.typed.length, typedBefore, "the superseded tick typed nothing");
  assert.deepEqual((await t.store.log()).filter((m) => m.delivered && /Aya round/.test(m.text)), []);
  assert.deepEqual((await t.store.log()).filter((m) => m.typedOnly), []);
  await t.beat(t.scheduled.at(-1), 0);
  assert.deepEqual(roundTexts(t).map((x) => x.slice(0, 12)), ["Aya round 1:"]);
  assert.equal(await t.store.lastRound(), 1);
});

test("a peer message that reached the composer before a prompt appeared is not typed a second time", async () => {
  const { PaneHeldError } = await import("../dist-electron/team-control.js");
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "peer report", delivered: false });
    let calls = 0;
    t.deps.deliver = async () => {
      calls++;
      throw new PaneHeldError("shows an approval prompt; it appeared after the text was typed", true);
    };
    await t.runner.redeliverWaiting();
    await t.runner.redeliverWaiting();
    assert.equal(calls, 1);
    assert.deepEqual(await t.store.unread("implementer"), []);
  } finally {
    t.cleanup();
  }
});

test("a pane held before the paste keeps the message owed", async () => {
  const { PaneHeldError } = await import("../dist-electron/team-control.js");
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "peer report", delivered: false });
    t.deps.deliver = async () => {
      throw new PaneHeldError("shows an approval prompt");
    };
    await t.runner.redeliverWaiting();
    assert.equal((await t.store.unread("implementer")).length, 1);
  } finally {
    t.cleanup();
  }
});

test("a round writes its number and its clock in one write: a crash between cannot resend the round", async () => {
  const t = await setup();
  const proto = (await import("../dist-electron/team-store.js")).TeamStore.prototype;
  const { recordRound } = proto;
  try {
    await t.runner.start("game", "ux-review");
    const clockBefore = await t.store.roundClockAt();
    proto.recordRound = async () => {
      throw new Error("crash");
    };
    await t.beat();
    const advanced = (await t.store.roundClockAt()) !== clockBefore;
    assert.equal(advanced, (await t.store.lastRound()) === 1, "clock and round number move together");
  } finally {
    proto.recordRound = recordRound;
    t.cleanup();
  }
});

runnerTest("two Starts at once (two panes) type the delivery tests and the task once", { cadence: false }, async (t) => {
  const results = await Promise.all([t.runner.start("game", "ux-review", { text: "build it" }), t.runner.start("game", "ux-review", { text: "build it" })]);
  assert.deepEqual(results.map((r) => r.started).sort(), [false, true]);
  assert.equal(results.find((r) => !r.started).alreadyRunning, true);
  assert.equal(t.typed.filter((w) => /build it/.test(w.text)).length, 1);
  assert.equal(t.typed.filter((w) => /Delivery test/.test(w.text)).length, 2);
});

runnerTest("a Save that removes the cadence (and so the lead) stops the rounds, and the team stays running", async (t) => {
  await t.runner.start("game", "ux-review");
  assert.equal(t.scheduled.length, 1);
  assert.equal(t.scheduled[0].cancelled, false);
  breakSaved({ teamHome: t.deps.teamHome }, TEAM(false));
  await t.runner.refresh("game", "ux-review");
  assert.equal(t.scheduled[0].cancelled, true, "the old clock is cancelled");
  assert.equal(t.scheduled.filter((j) => !j.cancelled).length, 1, "one clock watches the repo in its place (E2)");
  t.typed.length = 0;
  await t.beat();
  assert.deepEqual(t.typed, [], "and it types no round");
  assert.equal((await t.store.state()).running, true);
});

// busy x approval for a round, whatever the CLI draws: an approval is the hold that names what the person must do.
for (const [busy, held, expected] of [
  [false, null, "typed"],
  [true, null, "is busy working"],
  [false, "shows an approval prompt", "shows an approval prompt"],
  [true, "shows an approval prompt", "shows an approval prompt"],
]) {
  runnerTest(`round | busy ${busy}, hold ${JSON.stringify(held)}: ${expected === "typed" ? "typed" : `skipped as "${expected}"`}`, async (t) => {
    await t.runner.start("game", "ux-review");
    t.deps.holdReason = async (pane) => (pane === "pane-t" ? held : null);
    t.deps.busy = async (pane) => pane === "pane-t" && busy;
    const before = roundTexts(t).length;
    await t.beat();
    const log = await t.store.log();
    if (expected === "typed") assert.equal(roundTexts(t).length, before + 1);
    else {
      assert.equal(roundTexts(t).length, before, "nothing typed");
      assert.equal(log.at(-1).text, `Aya round 1 skipped: ${expected}`);
    }
  });
}

runnerTest("two looks of the clock that overlap (the first still typing) type the due round once", async (t) => {
  await t.runner.start("game", "ux-review");
  let reached;
  const inDeliver = new Promise((resolve) => (reached = resolve));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const deliver = t.deps.deliver;
  t.deps.deliver = async (pane, text, ...rest) => {
    if (/Aya round/.test(text)) {
      reached();
      await gate;
    }
    return deliver(pane, text, ...rest);
  };
  const job = t.scheduled.at(-1);
  t.now += CADENCE_MS;
  const looks = [job.fn(), job.fn()];
  await inDeliver;
  release();
  await Promise.all(looks);
  assert.equal(roundTexts(t).length, 1, roundTexts(t).join(" | "));
  assert.equal(await t.store.lastRound(), 1);
});

test("a role's Start logs a resume only of its own pause", async () => {
  const t = await setup();
  try {
    const resumed = async () => (await t.store.log()).filter((m) => m.text === "tester (the lead) resumed the team it paused").length;
    await t.runner.start("game", "ux-review", undefined, "tester");
    assert.equal(await resumed(), 0, "never paused");
    await t.runner.pause("game", "ux-review", "tester");
    await t.runner.start("game", "ux-review", undefined, "tester");
    assert.equal(await resumed(), 1);
  } finally {
    t.runner.stopAll();
    t.cleanup();
  }
});

test("a Pause that lands while restore reads a team leaves it without a clock", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    t.runner.stopAll();
    const jobs = [];
    const relaunched = new TeamRunner(t.deps, (fn, ms) => {
      const job = { fn, ms, cancelled: false };
      jobs.push(job);
      return () => (job.cancelled = true);
    }, () => t.now);
    const proto = TeamStore.prototype;
    const saved = proto.roundClockAt;
    let paused = false;
    proto.roundClockAt = async function () {
      if (!paused) {
        paused = true;
        await relaunched.pause("game", "ux-review");
      }
      return saved.call(this);
    };
    try {
      await relaunched.restore();
    } finally {
      proto.roundClockAt = saved;
    }
    assert.equal(paused, true, "the pause landed during restore");
    assert.deepEqual(jobs.filter((j) => !j.cancelled), []);
  } finally {
    t.cleanup();
  }
});

test("restore arms the teams after one whose files fail to read", async () => {
  const t = await setup();
  const proto = TeamStore.prototype;
  const progress = proto.progress;
  try {
    await t.runner.start("game", "ux-review");
    t.runner.stopAll();
    // A second running team, sorted first, whose progress file throws (a parse failure is handled closer in).
    const broken = new TeamStore(teamDir(t.deps.teamHome, "game", "aaa-broken"));
    await broken.saveDefinition(TEAM(true));
    await broken.setPaused(false);
    proto.progress = async function () {
      if (this.dir.includes("aaa-broken")) throw new Error("progress unreadable");
      return progress.call(this);
    };
    const warned = [];
    const jobs = [];
    const relaunched = new TeamRunner(t.deps, (fn, ms) => {
      const job = { fn, ms, cancelled: false };
      jobs.push(job);
      return () => (job.cancelled = true);
    }, () => t.now, (...args) => warned.push(args.join(" ")));
    await relaunched.restore();
    assert.equal(jobs.length, 1, "ux-review got its round clock");
    assert.ok(warned.some((w) => w.includes("game/aaa-broken not restored")), warned.join("\n"));
    relaunched.stopAll();
  } finally {
    proto.progress = progress;
    t.runner.stopAll();
    t.cleanup();
  }
});
