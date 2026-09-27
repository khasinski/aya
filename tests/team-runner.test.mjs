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

test("a held pane is reported, not typed into", async () => {
  const t = await setup({ cadence: false, held: { "pane-i": "shows an approval prompt" } });
  try {
    const result = await t.runner.start("game", "ux-review");
    assert.deepEqual(result.delivered, ["tester"]);
    assert.deepEqual(result.held, [{ role: "implementer", reason: "shows an approval prompt" }]);
    assert.equal(t.typed.filter((w) => w.pane === "pane-i").length, 0);
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
