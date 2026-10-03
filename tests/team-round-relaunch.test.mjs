// Aya goes down while a message to a pane is in flight: before its Enter, or after it while the turn it starts is
// still being proven (up to 6 s).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TURN_NOT_SEEN } = await import("../dist-electron/control.js");
const { TEAM_MINUTE_MS } = await import("../dist-electron/paths.js");

const CADENCE_MS = 30 * TEAM_MINUTE_MS;
const START = Date.parse("2026-10-02T10:00:00Z");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester
Must not: skip a report

## Cadence
tester every 30 min
`;

async function setup() {
  const t = teamProject("aya-round-relaunch-", { teamFile: TEAM });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const typed = [];
  const jobs = [];
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text, _cancelled, entered) => {
      typed.push({ pane, text });
      await entered?.();
    },
    holdReason: async () => null,
    headCommit: async () => null,
  };
  const clock = { now: START };
  const warned = [];
  const runner = () =>
    new TeamRunner(deps, (fn) => {
      jobs.push(fn);
      return () => {};
    }, () => clock.now, (...args) => warned.push(args.map(String).join(" ")));
  return { ...t, store, typed, jobs, deps, clock, runner, warned };
}

const relaunchTest = (name, ...args) => {
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

const DIST = resolve("dist-electron");
const MOMENTS = {
  "after its Enter, while its turn is proven": "await entered?.(); process.exit(7);",
  "after its paste, before its Enter": "process.exit(7);",
};

// A second process stands for the Aya that went down; `cue` is the text of the message it dies on.
const KINDS = {
  "a round": {
    cue: /Round/,
    run: `
      let tick;
      const runner = new TeamRunner(deps, (fn) => ((tick = fn), () => {}), () => now);
      runner.start("game", "ux-review").then(() => { now += ${CADENCE_MS}; return tick(); });`,
  },
  "a delivery test": {
    cue: /Delivery test/,
    run: `new TeamRunner(deps, () => () => {}, () => now).start("game", "ux-review");`,
  },
  "aya team send": {
    cue: /found a bug/,
    run: `handleTeamRequest({ type: "team-send", role: "implementer", text: "found a bug" }, "pane-t", deps);`,
  },
  "the Start's task": {
    cue: /found a bug/,
    run: `new TeamRunner(deps, () => () => {}, () => now).start("game", "ux-review", { text: "found a bug", to: "implementer" });`,
  },
};

function goDown(t, kind, moment) {
  const script = `
    const { TeamRunner } = require(${JSON.stringify(`${DIST}/team-runner.js`)});
    const { handleTeamRequest } = require(${JSON.stringify(`${DIST}/team-control.js`)});
    const project = ${JSON.stringify(t.project)};
    let now = ${START};
    const deps = {
      teamHome: ${JSON.stringify(t.teamHome)},
      listProjects: async () => [project],
      deliver: async (pane, text, cancelled, entered, pasting) => {
        await pasting?.();
        if (${KINDS[kind].cue}.test(text)) { ${MOMENTS[moment]} }
        await entered?.();
      },
      holdReason: async () => null,
      headCommit: async () => null,
    };
    ${KINDS[kind].run}`;
  assert.throws(() => execFileSync(process.execPath, ["-e", script], { stdio: "pipe" }), (err) => err.status === 7 || assert.fail(String(err.stderr)));
}

for (const kind of Object.keys(KINDS)) {
  for (const moment of Object.keys(MOMENTS)) {
    const entered = moment.startsWith("after its Enter");
    relaunchTest(`Aya goes down with ${kind} in flight, ${moment}: the next life does not type it twice`, async (t) => {
      goDown(t, kind, moment);
      t.clock.now = START + 2 * CADENCE_MS;
      const next = t.runner();
      await next.restore();
      await next.redeliverWaiting();
      const cued = (await t.store.annotatedLog()).filter((m) => KINDS[kind].cue.test(m.text));
      if (kind === "a round") {
        assert.equal(await t.store.lastRound(), entered ? 1 : 0, "the round counts once its Enter went, not before");
        assert.deepEqual(cued.map((m) => [m.text.slice(0, 8), m.delivered]), entered ? [["Round 1:", true]] : [], "the log has it as typed once its Enter went");
        for (const job of t.jobs) await job();
        const rounds = t.typed.filter((w) => w.pane === "pane-t").map((w) => w.text.replace(/^.*\] /, "").slice(0, 8));
        assert.deepEqual(rounds, [entered ? "Round 2:" : "Round 1:"], "the next round has the next number");
        assert.equal(await t.store.lastRound(), entered ? 2 : 1);
        return;
      }
      assert.equal(t.typed.filter((w) => KINDS[kind].cue.test(w.text)).length, 0, "the next life does not type it again");
      if (kind === "a delivery test" && !entered) return; // logged once typed; nothing went in, nothing is resent
      assert.ok(cued.length >= 1, "it is in the log");
      assert.ok(cued.every((m) => m.delivered), JSON.stringify(cued));
    });
  }
}

relaunchTest("Aya goes down between a round's number and its log entry: the number is used up first", async (t) => {
  const script = `
    const { TeamRunner } = require(${JSON.stringify(`${DIST}/team-runner.js`)});
    const { TeamStore } = require(${JSON.stringify(`${DIST}/team-store.js`)});
    const append = TeamStore.prototype.append;
    TeamStore.prototype.append = function (m) { return /^Round/.test(m.text) ? process.exit(7) : append.call(this, m); };
    const project = ${JSON.stringify(t.project)};
    let now = ${START};
    const deps = {
      teamHome: ${JSON.stringify(t.teamHome)},
      listProjects: async () => [project],
      deliver: async (pane, text, cancelled, entered) => { await entered?.(); },
      holdReason: async () => null,
      headCommit: async () => null,
    };
    ${KINDS["a round"].run}`;
  assert.throws(() => execFileSync(process.execPath, ["-e", script], { stdio: "pipe" }), (err) => err.status === 7 || assert.fail(String(err.stderr)));
  assert.equal(await t.store.lastRound(), 1);
  t.clock.now = START + 2 * CADENCE_MS;
  await t.runner().restore();
  for (const job of t.jobs) await job();
  assert.deepEqual(t.typed.map((w) => w.text.replace(/^.*\] /, "").slice(0, 8)), ["Round 2:"]);
});

// In one life: the turn proof's outcome is a note on the entry written at the Enter, never a second entry, and never
// a skip: the agent has the round.
const NOT_TAKEN = "did not take the text (it may have exited)";
for (const [label, proof, held] of [
  ["seen to start a turn", () => null, null],
  ["not seen to start a turn", () => TURN_NOT_SEEN, TURN_NOT_SEEN],
  ["whose pane fails after its Enter", () => {
    throw new Error("pane gone");
  }, NOT_TAKEN],
]) for (const quit of [true, false]) {
  relaunchTest(`a round ${label}, ${quit ? "Aya quit" : "Aya running"} meanwhile: one log entry, written at its Enter, with the proof's outcome on it`, async (t) => {
    const r = t.runner();
    await r.start("game", "ux-review");
    let release;
    const proven = new Promise((resolve) => (release = resolve));
    let reached;
    const atEnter = new Promise((resolve) => (reached = resolve));
    const deliver = t.deps.deliver;
    t.deps.deliver = async (pane, text, cancelled, entered) => {
      await deliver(pane, text, cancelled, entered);
      if (!/Round/.test(text)) return null;
      reached();
      await proven;
      return proof();
    };
    t.clock.now += CADENCE_MS;
    const tick = t.jobs.at(-1)();
    await atEnter;
    assert.equal(await t.store.lastRound(), 1, "the number is taken at the Enter");
    assert.equal((await t.store.log()).filter((m) => /^Round 1:/.test(m.text)).length, 1, "and the round is logged as typed");
    // Quit now: the next life types Round 2, whatever the proof says later.
    if (quit) r.stopAll();
    release();
    await tick;
    const rounds = (await t.store.annotatedLog()).filter((m) => /^Round|^round/.test(m.text));
    assert.deepEqual(rounds.map((m) => [m.text.slice(0, 8), m.delivered, m.held ?? null, m.typedOnly ?? false]), [["Round 1:", true, held, held !== null]]);
    const next = t.runner();
    await next.restore();
    t.clock.now += CADENCE_MS;
    await t.jobs.at(-1)();
    assert.deepEqual(t.typed.filter((w) => /Round/.test(w.text)).map((w) => w.text.replace(/^.*\] /, "").slice(0, 8)), ["Round 1:", "Round 2:"]);
  });
}

for (const [what, method] of [["its log entry", "append"], ["its number", "recordRound"]]) {
  test(`a round typed but ${what} not written: Aya says so, and writes the rest`, async () => {
    const t = await setup();
    const real = TeamStore.prototype[method];
    try {
      await t.runner().start("game", "ux-review");
      TeamStore.prototype[method] = function (...args) {
        return method === "recordRound" || /^Round/.test(args[0].text) ? Promise.reject(new Error("disk full")) : real.apply(this, args);
      };
      t.clock.now += CADENCE_MS;
      await t.jobs.at(-1)();
      TeamStore.prototype[method] = real;
      assert.equal(await t.store.lastRound(), method === "recordRound" ? 0 : 1);
      assert.equal((await t.store.log()).filter((m) => /^Round 1:/.test(m.text) && m.delivered).length, method === "append" ? 0 : 1);
      assert.match(t.warned.join("\n"), /tester: typed into its pane, but not recorded \(disk full\)/);
    } finally {
      TeamStore.prototype[method] = real;
      t.cleanup();
    }
  });
}

relaunchTest("Start's delivery tests are logged once each, at their Enter", async (t) => {
  await t.runner().start("game", "ux-review");
  const tests = (await t.store.annotatedLog()).filter((m) => /^Delivery test/.test(m.text));
  assert.deepEqual(tests.map((m) => [m.to, m.delivered, m.held ?? null]), [["tester", true, null], ["implementer", true, null]]);
});

// The real pane path: `entered` runs once, right after the Enter is written and before the turn is looked for.
for (const probed of [true, false]) {
  test(`deliverTeamMessage runs entered after the Enter, before the turn proof | ${probed ? "with" : "without"} a probe`, async () => {
    const { deliverTeamMessage } = await import("../dist-electron/control.js");
    const writes = [];
    let looks = 0;
    const seen = [];
    const probe = { hold: async () => null, outputMark: () => 0, outputPaused: () => true, windowMs: 300, sleep: async () => void looks++ };
    const unseen = await deliverTeamMessage(async (_id, data) => void writes.push(data), "pane-x", "Round 4: go", async () => null, undefined, probed ? probe : undefined, async () => {
      seen.push({ writes: [...writes], looks });
    });
    assert.deepEqual(seen, [{ writes: [writes[0], "\r"], looks: 0 }]);
    assert.equal(unseen, probed ? TURN_NOT_SEEN : null);
    assert.equal(looks, probed ? 3 : 0, "the proof still looks for its whole window");
  });
}
