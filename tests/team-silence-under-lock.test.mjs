// A silence round waits for the lead's pane lock after its look; a peer report typed in that wait ends the
// silence, so the look is taken again under the lock.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-silence-lock-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest, PaneHeldError } = await import("../dist-electron/team-control.js");

const S = 1000;
const TEAM = (cadence) => `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
tester
${cadence ? "\n## Cadence\ntester every 30 min\n" : ""}`;

async function world({ cadence = false } = {}) {
  const { teamHome, project, cleanup } = teamProject("aya-silence-lock-", { teamFile: TEAM(cadence), tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: {}, typed: [], jobs: [], now: Date.parse("2026-09-30T10:00:00Z"), whileRoundWaits: null, commit: "c0" };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    // As main's deliver: whatever holds the lead's pane lock goes first, then the cancel is read, then the paste.
    deliver: async (pane, text, cancelled) => {
      if (pane === "pane-t" && /\| from aya \|/.test(text) && w.whileRoundWaits) {
        const hook = w.whileRoundWaits;
        w.whileRoundWaits = null;
        await hook();
      }
      if (cancelled?.()) throw new PaneHeldError("the team was paused or changed before it was typed; nothing typed", false);
      // The paste is in; what goes in before the Enter is read again by the Pause's check only.
      if (pane === "pane-t" && w.beforeEnter) {
        const hook = w.beforeEnter;
        w.beforeEnter = null;
        await hook();
      }
      if (cancelled?.()) throw new PaneHeldError("the team was paused or changed while it was typed; text left in the composer, Enter not sent", true);
      w.typed.push({ pane, text });
    },
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => w.commit,
  };
  w.runner = new TeamRunner(w.deps, (fn) => (w.jobs.push(fn), () => {}), () => w.now, () => {});
  const heldReport = async (text) => {
    w.holds["pane-t"] = "shows an approval prompt";
    await handleTeamRequest({ type: "team-send", role: "tester", text }, "pane-i", w.deps).catch(() => {});
    w.holds["pane-t"] = null;
  };
  const rounds = () => w.typed.filter((t) => t.pane === "pane-t" && /Round \d+:/.test(t.text)).map((t) => Number(t.text.match(/Round (\d+):/)[1]));
  const skips = async () => (await store.log()).filter((m) => m.from === "aya" && /skipped/.test(m.text)).map((m) => m.text);
  const check = () => w.jobs.at(-1)();
  return { w, store, heldReport, rounds, skips, check, cleanup: () => (w.runner.stopAll(), cleanup()) };
}

// [name, cadence, before the look, what goes in while the round waits, rounds after the look, rounds 91 s later]
const ROWS = [
  ["silence | nothing goes in -> the round is typed", false, 91, null, [1], [1, 2]],
  ["silence | a held report is typed -> no round now, the silence counts from that report", false, 91, "report", [], [1]],
  ["silence | a held one-word ack is typed -> no talk: the round is typed", false, 91, "ok", [1], [1, 2]],
  ["cadence beat | a held report is typed -> the beat still goes", true, 91, "report", [1], [1, 2]],
  ["silence | the implementer's report is sent straight to the lead -> no round now", false, 91, "send", [], null],
  ["silence | a report goes in after the round's paste, before its Enter -> the Enter goes, the round is typed", false, 91, "after paste", [1], null],
  ["stall | a held report is typed -> the stall round still goes (talk is no progress)", false, 181, "report", [1], [1]],
];

for (const [name, cadence, wait, goesIn, now, later] of ROWS) {
  test(`round under the lead's lock | ${name}`, async () => {
    const t = await world({ cadence });
    try {
      await t.w.runner.start("game", "ux-review");
      const REPORT = "report: the timer test fails on CI, details in notes/timer.md";
      if (goesIn === "report" || goesIn === "ok") await t.heldReport(goesIn === "report" ? REPORT : "ok");
      t.w.now += wait * S;
      if (goesIn === "report" || goesIn === "ok") t.w.whileRoundWaits = () => t.w.runner.redeliverWaiting();
      const send = () => handleTeamRequest({ type: "team-send", role: "tester", text: REPORT }, "pane-i", t.w.deps);
      if (goesIn === "send") t.w.whileRoundWaits = send;
      if (goesIn === "after paste") t.w.beforeEnter = send;
      await t.check();
      assert.deepEqual(t.rounds(), now, "rounds the lead got at this look");
      assert.deepEqual(await t.skips(), [], "nothing logged as skipped");
      if (!now.length) assert.equal(await t.store.lastRound(), 0, "the round number is not used up");
      if (later === null) return; // a message sent now carries the wall clock's time, not the fake one
      t.w.now += 91 * S;
      await t.check();
      assert.deepEqual(t.rounds(), later, "rounds 91 s later");
    } finally {
      t.cleanup();
    }
  });
}
