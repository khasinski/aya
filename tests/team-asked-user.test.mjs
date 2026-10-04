// A round skipped because the lead asked the user leaves a line in the team log, and only a real question skips it.
// One team "minute" lasts 3 s here, so the rhythm is 90 s and the quiet-team clock 90 s.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-asked-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { recordAgentStatus } = await import("../dist-electron/agent-status.js");

const S = 1000;
const TEAM = ({ cadence }) => `# ux-review

## Role: leader
Sends to: implementer (tasks)
Must not: edit code

## Role: implementer
Sends to: leader (results)
Must not: skip a report

## Lead
leader
${cadence ? "\n## Cadence\nleader every 30 min\n" : ""}`;

async function world({ cadence = false } = {}) {
  for (const pane of ["pane-l", "pane-i"]) recordAgentStatus(pane, "clear", 0);
  const { teamHome, project, cleanup } = teamProject("aya-asked-", { teamFile: TEAM({ cadence }), tabs: [{ id: "pane-l" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("leader", "pane-l");
  await store.assign("implementer", "pane-i");
  const w = { typed: [], jobs: [], now: Date.parse("2026-10-01T20:30:00Z") };
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text }),
    holdReason: async () => null,
    headCommit: async () => "c0",
  };
  const make = () => {
    w.jobs.length = 0;
    w.runner = new TeamRunner(deps, (fn) => (w.jobs.push(fn), () => {}), () => w.now, () => {});
  };
  make();
  const ACTIONS = {
    start: () => w.runner.start("game", "ux-review"),
    tick: () => w.jobs.at(-1)(),
    check: () => w.jobs.at(-1)(),
    restart: () => (make(), w.runner.restore()),
    // What the hook script sends when Grok or Claude sits on an idle composer.
    "hook says waiting": () => recordAgentStatus("pane-l", "waiting", w.now, "Waiting for your next prompt", "hook"),
    "lead asks the user": () => recordAgentStatus("pane-l", "waiting", w.now, "need the staging password"),
    // `aya status waiting --on implementer`: a wait on the team, not a question.
    "lead waits on implementer": () => recordAgentStatus("pane-l", "waiting", w.now, "parser result", undefined, undefined, "implementer"),
    "hook ends the turn": () => recordAgentStatus("pane-l", "done", w.now, "Turn finished", "hook"),
    "lead answers": () => handleTeamRequest({ type: "team-send", role: "implementer", text: "decision: use the new parser" }, "pane-l", deps).catch(() => {}),
  };
  const run = async (...steps) => {
    for (const step of steps) {
      if (typeof step === "number") w.now += step * S;
      else await ACTIONS[step]();
    }
  };
  const rounds = () => w.typed.filter((t) => t.pane === "pane-l").flatMap((t) => t.text.match(/Round (\d+):/)?.[1] ?? []).map(Number);
  const skipped = async () => (await store.log()).filter((m) => m.from === "aya" && /skipped/.test(m.text)).map((m) => `${m.to}: ${m.text}`);
  const typedTo = (pane) => w.typed.filter((t) => t.pane === pane).map((t) => t.text);
  return { run, rounds, skipped, typedTo, cleanup };
}

const askedTest = (name, ...args) => {
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

const ASKED = "leader: round 1 skipped: leader asked the user: need the staging password";

// [name, options, steps (numbers are seconds), rounds the lead got, skip lines in the log]
const CASES = [
  ["an idle lead (hook Notification) gets the periodic round", { cadence: true }, ["start", 50, "hook says waiting", 41, "tick"], [1], []],
  ["an idle lead (hook Notification) gets the quiet-team round", {}, ["start", 50, "hook says waiting", 41, "check"], [1], []],
  ["a lead that asked the user: the periodic round is skipped, and the log says why", { cadence: true }, ["start", 50, "lead asks the user", 41, "tick"], [], [ASKED]],
  ["... the hook ending that turn does not end the question", { cadence: true }, ["start", 50, "lead asks the user", "hook ends the turn", 41, "tick"], [], [ASKED]],
  ["a lead that asked the user: the quiet-team round is skipped, and the log says why", {}, ["start", 50, "lead asks the user", 41, "check"], [], [ASKED]],
  ["... one line per round and question, however many checks", {}, ["start", 50, "lead asks the user", 41, "check", 10, "check", 10, "check"], [], [ASKED]],
  ["... and the beats after it the same", { cadence: true }, ["start", 50, "lead asks the user", 41, "tick", 90, "tick"], [], [ASKED]],
  ["a lead that asked the user: the stall round is skipped, and the log says why", {}, ["start", 10, "lead asks the user", 175, "check"], [], [ASKED]],
  ["a question before the last progress skips nothing", { cadence: true }, ["start", 10, "lead asks the user", 10, "lead answers", 71, "tick"], [1], []],
  ["a restart while the lead waits is not a skipped round", {}, ["start", 10, "lead asks the user", 5, "restart"], [], []],
  ["a lead waiting on a teammate gets the periodic round", { cadence: true }, ["start", 50, "lead waits on implementer", 41, "tick"], [1], []],
  ["a lead waiting on a teammate gets the quiet-team round", {}, ["start", 50, "lead waits on implementer", 41, "check"], [1], []],
  ["... the hook ending that turn changes nothing", {}, ["start", 50, "lead waits on implementer", "hook ends the turn", 41, "check"], [1], []],
];

for (const [name, opts, steps, expected, lines] of CASES) {
  askedTest(`asked the user | ${name}`, opts, async (t) => {
    await t.run(...steps);
    assert.deepEqual(t.rounds(), expected, "rounds the lead got");
    assert.deepEqual(await t.skipped(), lines, "skipped rounds in the team log");
  });
}

// [round, steps, what the round says of the wait]
const SAID = [
  ["the periodic round (digest)", { cadence: true }, ["start", 50, "lead answers", "lead waits on implementer", 41, "tick"], /Said they wait on a teammate: leader on implementer for 0 min: "parser result"\./],
  ["the quiet-team round", {}, ["start", 50, "lead waits on implementer", 41, "check"], /Said they wait \(aya status\): leader on implementer since \d\d:\d\d \(\d+ min\)\./],
];
for (const [name, opts, steps, says] of SAID) {
  askedTest(`asked the user | ${name} tells the lead who said it waits on a teammate`, opts, async (t) => {
    await t.run(...steps);
    const round = t.typedTo("pane-l").find((text) => /Round 1:/.test(text));
    assert.match(round, says);
    assert.doesNotMatch(round, /only the user/);
  });
}
