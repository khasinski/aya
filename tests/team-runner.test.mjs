// Start team (delivery test), Aya-owned rounds and the team pause (D15, D20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
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
  const root = mkdtempSync(join(tmpdir(), "aya-runner-"));
  const directory = join(root, "game");
  mkdirSync(join(directory, ".aya", "teams"), { recursive: true });
  writeFileSync(join(directory, ".aya", "teams", "ux-review.md"), TEAM(cadence));
  const teamHome = join(root, "aya");
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const project = { slug: "game", name: "game", directory, tabs: [{ id: "pane-t" }, { id: "pane-i" }] };
  const typed = [];
  const scheduled = [];
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async (pane) => held[pane] ?? null,
    headCommit: async () => null,
  };
  const runner = new TeamRunner(deps, (fn, ms) => {
    const job = { fn, ms, cancelled: false };
    scheduled.push(job);
    return () => (job.cancelled = true);
  });
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { runner, typed, scheduled, store, deps, cleanup };
}

test("start sends every role a delivery test that names its peer", async () => {
  const t = await setup({ cadence: false });
  try {
    const result = await t.runner.start("game", "ux-review");
    assert.equal(result.started, true);
    assert.deepEqual(result.delivered.sort(), ["implementer", "tester"]);
    const toTester = t.typed.find((w) => w.pane === "pane-t").text;
    assert.match(toTester, /^\[team ux-review \| from aya \| \d\d:\d\d\]/);
    assert.match(toTester, /aya team whoami/);
    assert.match(toTester, /aya team send implementer/);
    assert.equal(t.scheduled.length, 0);
  } finally {
    t.cleanup();
  }
});

test("Start checks every pane first: one not ready means nothing is sent and no rounds run", async () => {
  const t = await setup({ held: { "pane-i": "shows an approval prompt" } });
  try {
    const result = await t.runner.start("game", "ux-review");
    assert.equal(result.started, false);
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.held, [{ role: "implementer", reason: "shows an approval prompt" }]);
    assert.equal(t.typed.length, 0);
    assert.equal(t.scheduled.length, 0);
    assert.equal((await t.store.state()).running, false);
    assert.equal((await t.store.log()).length, 0);
  } finally {
    t.cleanup();
  }
});

test("Start lists every role that is not ready, including one with no pane", async () => {
  const t = await setup({ cadence: false, held: { "pane-t": "is not running" } });
  try {
    await t.store.releasePane("pane-i");
    const result = await t.runner.start("game", "ux-review");
    assert.equal(result.started, false);
    assert.deepEqual(result.held, [
      { role: "tester", reason: "is not running" },
      { role: "implementer", reason: "no pane assigned" },
    ]);
  } finally {
    t.cleanup();
  }
});
test("rounds go to the cadence role on its interval and are numbered", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    assert.equal(t.scheduled.length, 1);
    assert.equal(t.scheduled[0].ms, 30 * 60 * 1000);
    t.typed.length = 0;
    await t.scheduled[0].fn();
    await t.scheduled[0].fn();
    assert.deepEqual(t.typed.map((w) => w.pane), ["pane-t", "pane-t"]);
    assert.match(t.typed[0].text, /round 1/i);
    assert.match(t.typed[1].text, /round 2/i);
  } finally {
    t.cleanup();
  }
});

test("a round is skipped, not queued, while the pane is held", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    t.typed.length = 0;
    t.deps.holdReason = async () => "has text the user is typing";
    await t.scheduled[0].fn();
    assert.equal(t.typed.length, 0);
    t.deps.holdReason = async () => null;
    await t.scheduled[0].fn();
    assert.match(t.typed[0].text, /round 1/i);
  } finally {
    t.cleanup();
  }
});

test("pause stops rounds and team sends; resume brings both back", async () => {
  const t = await setup();
  try {
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
  } finally {
    t.cleanup();
  }
});

test("a round already in flight when the team pauses types nothing", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    const round = t.scheduled[0].fn;
    await t.runner.pause("game", "ux-review");
    t.typed.length = 0;
    await round();
    assert.equal(t.typed.length, 0);
  } finally {
    t.cleanup();
  }
});

test("Start team after a pause takes messages again", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.runner.pause("game", "ux-review");
    await t.runner.start("game", "ux-review");
    t.typed.length = 0;
    await handleTeamRequest({ type: "team-send", role: "implementer", text: "x" }, "pane-t", t.deps);
    assert.equal(t.typed.length, 1);
  } finally {
    t.cleanup();
  }
});

test("Start with a pane that refuses the text reports it and still arms the rounds", async () => {
  const t = await setup();
  try {
    t.deps.deliver = async (pane) => {
      if (pane === "pane-i") throw new Error("pane did not accept the text");
    };
    const result = await t.runner.start("game", "ux-review");
    assert.deepEqual(result.held, [{ role: "implementer", reason: "did not take the text (it may have exited)" }]);
    assert.equal(t.scheduled.length, 1);
    assert.equal((await t.store.unread("implementer")).length, 1);
  } finally {
    t.cleanup();
  }
});

test("after a relaunch, restore re-arms the teams that were running", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    const fresh = new TeamRunner(t.deps, (fn, ms) => {
      t.scheduled.push({ fn, ms, cancelled: false });
      return () => {};
    });
    const before = t.scheduled.length;
    await fresh.restore();
    assert.equal(t.scheduled.length, before + 1);
  } finally {
    t.cleanup();
  }
});

test("saving a running team re-arms its rounds from the new definition", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    await t.store.saveDefinition(TEAM(true).replace("tester every 30 min", "implementer every 5 min"));
    await t.runner.refresh("game", "ux-review");
    assert.equal(t.scheduled[0].cancelled, true);
    assert.equal(t.scheduled.at(-1).ms, 5 * 60 * 1000);
  } finally {
    t.cleanup();
  }
});

test("a round tick never rejects: a closed project or a failing pane only skips the round", async () => {
  const t = await setup();
  try {
    await t.runner.start("game", "ux-review");
    t.deps.listProjects = async () => [];
    await t.scheduled[0].fn();
    t.deps.listProjects = async () => [{ slug: "game", name: "game", directory: "/nonexistent", tabs: [] }];
    t.deps.deliver = async () => {
      throw new Error("pane gone");
    };
    await t.scheduled[0].fn();
  } finally {
    t.cleanup();
  }
});

test("Aya's messages carry the commit in the header, as the log does", async () => {
  const t = await setup();
  try {
    t.deps.headCommit = async () => "abc1234";
    await t.runner.start("game", "ux-review");
    assert.match(t.typed[0].text, /^\[team ux-review \| from aya \| \d\d:\d\d \| abc1234\] Delivery test/);
    assert.equal((await t.store.log()).at(-1).commit, "abc1234");
  } finally {
    t.cleanup();
  }
});

test("a role given to a pane in a running team is introduced at once, as Start would", async () => {
  const t = await setup({ cadence: false });
  try {
    assert.equal(await t.runner.introduce("game", "ux-review", "implementer"), null);
    assert.equal(t.typed.length, 0, "before Start, Start tells it");
    await t.runner.start("game", "ux-review");
    t.typed.length = 0;
    assert.equal(await t.runner.introduce("game", "ux-review", "implementer"), null);
    assert.deepEqual(t.typed.map((w) => w.pane), ["pane-i"]);
    assert.match(t.typed[0].text, /Delivery test: run aya team whoami, then send one word to tester/);
    await t.store.setPaused(true);
    assert.equal(await t.runner.introduce("game", "ux-review", "tester"), null);
    assert.equal(t.typed.length, 1);
  } finally {
    t.cleanup();
  }
});

test("introducing a held pane says why and keeps the message", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.runner.start("game", "ux-review");
    t.deps.holdReason = async (pane) => (pane === "pane-t" ? "shows an approval prompt" : null);
    assert.equal(await t.runner.introduce("game", "ux-review", "tester"), "shows an approval prompt");
    assert.equal((await t.store.log()).filter((m) => m.to === "tester" && !m.delivered).length, 1);
  } finally {
    t.cleanup();
  }
});

test("a held message is typed once the receiving pane is free, with its own header and time", async () => {
  const t = await setup({ cadence: false });
  try {
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
  } finally {
    t.cleanup();
  }
});

test("held messages wait while the team is paused or the role has no pane", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "x", delivered: false });
    await t.store.setPaused(true);
    assert.equal(await t.runner.redeliverWaiting(), 0);
    await t.store.setPaused(false);
    await t.store.releasePane("pane-i");
    assert.equal(await t.runner.redeliverWaiting(), 0);
    assert.equal(t.typed.length, 0);
    assert.equal((await t.store.unread("implementer")).length, 1);
  } finally {
    t.cleanup();
  }
});

test("a pane that refuses a waiting message keeps it and the ones after it", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.store.setPaused(false);
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "first", delivered: false });
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "second", delivered: false });
    let calls = 0;
    t.deps.deliver = async () => {
      if (++calls === 2) throw new Error("pane gone");
    };
    assert.equal(await t.runner.redeliverWaiting(), 1);
    assert.deepEqual((await t.store.unread("implementer")).map((m) => m.text), ["second"]);
  } finally {
    t.cleanup();
  }
});

test("overlapping redelivery passes type each held message once", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "first", delivered: false });
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "second", delivered: false });
    t.deps.deliver = async (pane, text) => {
      await new Promise((r) => setTimeout(r, 20));
      t.typed.push({ pane, text });
    };
    await Promise.all([t.runner.redeliverWaiting(), t.runner.redeliverWaiting()]);
    assert.deepEqual(t.typed.map((w) => w.text.split("] ")[1]), ["first", "second"]);
    assert.equal((await t.store.unread("implementer")).length, 0);
  } finally {
    t.cleanup();
  }
});

test("a pane that becomes held mid-redelivery keeps the rest waiting", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "first", delivered: false });
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "second", delivered: false });
    t.deps.holdReason = async () => (t.typed.length ? "shows an approval prompt" : null);
    assert.equal(await t.runner.redeliverWaiting(), 1);
    assert.deepEqual(t.typed.map((w) => w.text.split("] ")[1]), ["first"]);
    assert.deepEqual((await t.store.unread("implementer")).map((m) => m.text), ["second"]);
  } finally {
    t.cleanup();
  }
});

test("a redelivered line carries no control bytes, header included", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "tester\x1b[201~\r", to: "implementer", commit: null, text: "x", delivered: false });
    assert.equal(await t.runner.redeliverWaiting(), 1);
    assert.doesNotMatch(t.typed[0].text, /[\x00-\x1f\x7f]/);
  } finally {
    t.cleanup();
  }
});

test("when the pane is held mid-pass, later messages wait even if it frees again: order is kept", async () => {
  const t = await setup({ cadence: false });
  try {
    for (const text of ["first", "second", "third"]) {
      await t.store.append({ from: "tester", to: "implementer", commit: null, text, delivered: false });
    }
    // Free, then held (a prompt after the first), then free again.
    const states = [null, "shows an approval prompt", null];
    t.deps.holdReason = async () => (states.length ? states.shift() : null);
    await t.runner.redeliverWaiting();
    assert.deepEqual(t.typed.map((w) => w.text.replace(/^.*\] /, "")), ["first"]);
    assert.deepEqual((await t.store.unread("implementer")).map((m) => m.text), ["second", "third"]);
  } finally {
    t.cleanup();
  }
});

test("Aya's own held messages (rounds, delivery tests) are never typed later: they go stale", async () => {
  const t = await setup({ cadence: false });
  try {
    await t.store.append({ from: "aya", to: "implementer", commit: null, text: "Round 1: run your round", delivered: false });
    await t.store.append({ from: "tester", to: "implementer", commit: null, text: "peer report", delivered: false });
    assert.equal(await t.runner.redeliverWaiting(), 1);
    assert.deepEqual(t.typed.map((w) => w.text.replace(/^.*\] /, "")), ["peer report"]);
  } finally {
    t.cleanup();
  }
});

