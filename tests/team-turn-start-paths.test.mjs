// Every path that types a team message: when its Enter was not seen to start a turn the window names it, progress
// does not count it as talk, and nothing types it again. One cadence "minute" is 3 s: the first silence round is at 90 s.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-turn-paths-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { messageDeliveryText, startSummary } from "../dist-test/team-view.js";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { observe } = await import("../dist-electron/team-progress.js");
const { listTeams } = await import("../dist-electron/team-admin.js");

const NOT_SEEN = "typed, not seen to start a turn";
const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
tester
`;

async function world() {
  const t = teamProject("aya-turn-paths-", { teamFile: TEAM, tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  // unseen: the panes whose Enter starts no turn.
  const w = { holds: {}, unseen: new Set(), typed: [], jobs: [], now: Date.parse("2026-09-30T10:00:00Z") };
  w.deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text) => {
      w.typed.push({ pane, text });
      return w.unseen.has(pane) ? NOT_SEEN : null;
    },
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => "c0",
    busy: async () => false,
  };
  const schedule = (fn, ms) => {
    const job = { fn, ms };
    w.jobs.push(job);
    return () => {};
  };
  w.runner = new TeamRunner(w.deps, schedule, () => w.now, () => {});
  const send = (pane, role, text) => handleTeamRequest({ type: "team-send", role, text }, pane, w.deps).then((r) => r.output, (e) => `FAIL ${e.message}`);
  const shown = async () => (await listTeams(t.teamHome, t.project))[0].log.map((m) => `${m.from}>${m.to} ${messageDeliveryText(m)}`);
  const heard = async () => (await observe(store, "c0", {}, new Date(w.now).toISOString())).messages ?? 0;
  return { ...t, store, w, send, shown, heard };
}

const pathTest = (name, ...args) => {
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

pathTest("aya team send | a turn starts: written, and talk", async (t) => {
  await t.store.setPaused(false);
  assert.match(await t.send("pane-t", "implementer", "report A"), /^written to implementer's pane \(message 1\); this does not mean it was read/);
  assert.deepEqual(await t.shown(), ["tester>implementer written"]);
  assert.equal(await t.heard(), 1);
});

pathTest("aya team send | not seen: the sender is told, not asked to send again; the window names it; no talk", async (t) => {
  await t.store.setPaused(false);
  t.w.unseen.add("pane-i");
  assert.equal(await t.send("pane-t", "implementer", "report A"), "written to implementer's pane (message 1), but not seen to start a turn; it is not resent\n");
  assert.deepEqual(await t.shown(), [`tester>implementer ${NOT_SEEN}`]);
  assert.equal(await t.heard(), 0);
});

for (const [label, unseen, want, talk] of [
  ["a turn starts", false, "written later (was held: shows an approval prompt)", 1],
  ["not seen", true, NOT_SEEN, 0],
]) {
  pathTest(`redelivery of a held report | ${label}`, async (t) => {
    await t.store.setPaused(false);
    t.w.holds["pane-i"] = "shows an approval prompt";
    await t.send("pane-t", "implementer", "report A");
    const before = await t.heard();
    t.w.holds["pane-i"] = null;
    if (unseen) t.w.unseen.add("pane-i");
    await t.w.runner.redeliverWaiting();
    assert.deepEqual(await t.shown(), [`tester>implementer ${want}`]);
    const progress = await t.store.progress();
    assert.equal((progress?.messages ?? 0) - before, talk, "the redelivery counts as talk only when it was seen");
    assert.equal(await t.w.runner.redeliverWaiting(), 0, "typed once: never again");
  });
}

pathTest("Start | the delivery test and the task not seen: the role is marked, the task named", async (t) => {
  t.w.unseen.add("pane-i");
  const result = await t.w.runner.start("game", "ux-review", { text: "build the timer", to: "implementer" });
  assert.deepEqual(result.held, [{ role: "implementer", reason: NOT_SEEN }]);
  assert.deepEqual(result.delivered, ["tester"]);
  assert.equal(result.task.held, NOT_SEEN);
  assert.equal(result.task.typedOnly, true);
  assert.equal(result.task.afterEnter, true, "its Enter went: the reason says what came of it");
  const log = (await listTeams(t.teamHome, t.project))[0].log;
  assert.equal(startSummary(result, log)?.text, `Started; the roles marked below did not get the delivery test. The task for implementer was ${NOT_SEEN}.`);
});

pathTest("a round to the lead not seen: named in the window, and the next look does not type it again", async (t) => {
  await t.w.runner.start("game", "ux-review");
  t.w.unseen.add("pane-t");
  const tick = () => t.w.jobs.at(-1).fn();
  t.w.now += 91_000;
  await tick();
  const rounds = () => t.w.typed.filter((x) => x.pane === "pane-t" && /Aya round|no progress/.test(x.text)).length;
  assert.equal(rounds(), 1);
  const round = (await listTeams(t.teamHome, t.project))[0].log.filter((m) => m.from === "aya" && m.to === "tester").at(-1);
  assert.equal(messageDeliveryText(round), NOT_SEEN);
  t.w.now += 1_000;
  await tick();
  assert.equal(rounds(), 1, "one round per silence, not one per look");
});

test("aya team start | the task not seen: the CLI says it was typed, not seen to start a turn", async () => {
  const { handleTeamPanesRequest } = await import("../dist-electron/team-panes.js");
  const t = teamProject("aya-turn-start-cli-", { teamFile: TEAM, tabs: [{ id: "pane-t" }, { id: "pane-i" }, { id: "pane-x" }] });
  try {
    const deps = {
      teamHome: t.teamHome,
      listProjects: async () => [t.project],
      start: async () => ({ started: true, delivered: ["tester", "implementer"], held: [], task: { to: "implementer", held: NOT_SEEN, typedOnly: true, afterEnter: true, messageId: 3 } }),
    };
    const { output } = await handleTeamPanesRequest({ type: "team-start", team: "ux-review", task: "build the timer", to: "implementer" }, "pane-x", deps);
    assert.equal(output, `started team ux-review; delivery test written to tester, implementer; task for implementer was ${NOT_SEEN}\n`);
  } finally {
    t.cleanup();
  }
});
