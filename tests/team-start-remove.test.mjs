// Start x Remove, both orders: no clock of the removed team may stay, or it would type rounds into the lead's
// pane of a same-name team saved later and never started.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { listTeams, saveTeam } = await import("../dist-electron/team-admin.js");
const { parseTeamFile } = await import("../dist-electron/team-definition.js");
const { TEAM_MINUTE_MS } = await import("../dist-electron/paths.js");

const LEAD_ONLY = `# ux-review

## Role: tester
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: tester (a change to check)
Must not: skip a report

## Lead
implementer
`;
const TEAMS = {
  "a lead, no cadence": LEAD_ONLY,
  "a lead and a cadence": `${LEAD_ONLY}\n## Cadence\nimplementer every 30 min\n`,
};
const TASKS = { "no task": undefined, "a task": { text: "review the login page" } };

async function world(teamText) {
  const { teamHome, project, cleanup } = teamProject("aya-start-remove-", { teamFile: teamText });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = {
    teamHome,
    project,
    cleanup,
    store,
    now: Date.parse("2026-10-02T10:00:00Z"),
    typed: [],
    jobs: [],
    onDeliver: () => {},
    removeRepoFile: () => rmSync(join(project.directory, ".aya", "teams", "ux-review.md")),
  };
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => {
      w.typed.push({ pane, text });
      await w.onDeliver(w.typed.length);
    },
    holdReason: async () => null,
    headCommit: async () => null,
  };
  const schedule = (fn) => {
    const job = { fn, cancelled: false };
    w.jobs.push(job);
    return () => (job.cancelled = true);
  };
  w.runner = new TeamRunner(deps, schedule, () => w.now, () => {});
  w.liveClocks = () => w.jobs.filter((j) => !j.cancelled).length;
  return w;
}

/** The user writes a team of the same name again and saves it, never starts it; then 70 minutes pass. */
async function sameNameSavedLater(w) {
  await saveTeam(w.teamHome, w.project, parseTeamFile("ux-review", LEAD_ONLY), { create: true });
  const fresh = new TeamStore(teamDir(w.teamHome, "game", "ux-review"));
  await fresh.assign("tester", "pane-t");
  await fresh.assign("implementer", "pane-i");
  const before = w.typed.length;
  for (let i = 0; i < 70; i++) {
    w.now += TEAM_MINUTE_MS;
    for (const job of w.jobs.filter((j) => !j.cancelled)) await job.fn();
  }
  const [team] = (await listTeams(w.teamHome, w.project)).filter((t) => t.name === "ux-review");
  return { typed: w.typed.slice(before).map((t) => `${t.pane}: ${t.text}`), running: team.running, lastRound: await fresh.lastRound() };
}

const QUIET = { typed: [], running: false, lastRound: 0 };

for (const [teamName, teamText] of Object.entries(TEAMS)) {
  for (const [taskName, task] of Object.entries(TASKS)) {
    for (const at of [1, 2]) {
      test(`${teamName}, ${taskName} | Start, Remove clicked while delivery test ${at} is typed -> the team is gone, no clock left, a same-name team saved later gets no rounds`, async () => {
        const w = await world(teamText);
        try {
          let removal = null;
          w.onDeliver = (n) => {
            if (n !== at) return;
            w.removeRepoFile();
            removal = w.runner.remove("game", "ux-review");
          };
          await w.runner.start("game", "ux-review", task).catch(() => {});
          await removal;
          assert.deepEqual([w.liveClocks(), existsSync(w.store.dir)], [0, false]);
          assert.deepEqual(await sameNameSavedLater(w), QUIET);
        } finally {
          w.cleanup();
        }
      });
    }
    test(`${teamName}, ${taskName} | Remove, then Start -> Start refuses, nothing typed, no clock, nothing recreated`, async () => {
      const w = await world(teamText);
      try {
        w.removeRepoFile();
        await w.runner.remove("game", "ux-review");
        const start = await w.runner.start("game", "ux-review", task).then((r) => r.started, () => "refused");
        assert.deepEqual([start, w.typed, w.liveClocks(), existsSync(w.store.dir)], ["refused", [], 0, false]);
        assert.deepEqual(await sameNameSavedLater(w), QUIET);
      } finally {
        w.cleanup();
      }
    });
  }
}
