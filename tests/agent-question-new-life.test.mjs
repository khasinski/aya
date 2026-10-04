// A restored question belongs to the agent life that asked it: a new life never answers it, so it holds rounds
// only while the pane runs the session that asked. One team "minute" lasts 3 s: the quiet round is at 90 s.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-new-life-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";
import { TEST_TEAM_MINUTE_MS } from "./helpers/timings.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const status = await import("../dist-electron/agent-status.js");

const S = 1000;
const TEAM = `# ux-review

## Role: leader
Sends to: implementer (tasks)
Must not: edit code

## Role: implementer
Sends to: leader (results)
Must not: skip a report

## Lead
leader
`;
const QUESTION = "need the staging password";
const SKIPPED = `leader: Aya round 1 skipped: leader asked the user: ${QUESTION}`;
const BEFORE = `leader: question from before the restart: ${QUESTION}`;

async function world(sessionWhenAsked) {
  status.__resetAgentStatusForTests();
  const lead = { id: "pane-l", ...(sessionWhenAsked ? { sessionId: sessionWhenAsked } : {}) };
  const { teamHome, project, cleanup } = teamProject("aya-new-life-", { teamFile: TEAM, tabs: [lead, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("leader", "pane-l");
  await store.assign("implementer", "pane-i");
  const w = { typed: [], jobs: [], now: Date.parse("2026-10-02T10:00:00Z") };
  const deps = { teamHome, listProjects: async () => [project], deliver: async (pane, text) => void w.typed.push({ pane, text }), holdReason: async () => null, headCommit: async () => "c0" };
  const make = () => {
    w.jobs.length = 0;
    w.runner = new TeamRunner(deps, (fn) => (w.jobs.push(fn), () => {}), () => w.now, () => {});
  };
  make();
  const ACTIONS = {
    start: () => w.runner.start("game", "ux-review"),
    check: () => w.jobs.at(-1)(),
    "lead asks the user": () => status.recordAgentStatus("pane-l", "waiting", w.now, QUESTION, undefined, lead.sessionId),
    // Aya quits and starts again: the main process reads the questions from disk, the runner restores the team.
    restart: () => (status.__reloadAgentStatusForTests(), make(), w.runner.restore()),
  };
  const run = async (sessionAfter, ...steps) => {
    for (const step of steps) {
      if (typeof step === "number") w.now += step * S;
      else if (step === "new life") sessionAfter === undefined ? delete lead.sessionId : (lead.sessionId = sessionAfter);
      else await ACTIONS[step]();
    }
  };
  const rounds = () => w.typed.filter((t) => t.pane === "pane-l").flatMap((t) => t.text.match(/Aya round (\d+):/)?.[1] ?? []).map(Number);
  const lines = async () => (await store.log()).filter((m) => m.from === "aya" && /skipped|from before the restart/.test(m.text)).map((m) => `${m.to}: ${m.text}`);
  return { run, rounds, lines, cleanup };
}

// [label, session when asked, session after the restart, rounds the lead got, log lines]
const ROWS = [
  ["resumed the same session: still its question", "s-1", "s-1", [], [SKIPPED]],
  ["a new session: the question is the old life's", "s-1", "s-2", [1], [BEFORE]],
  ["no session known when it asked", undefined, "s-2", [1], [BEFORE]],
  ["no session known after the restart", "s-1", undefined, [1], [BEFORE]],
  ["no session known either time", undefined, undefined, [1], [BEFORE]],
];

for (const [label, asked, after, rounds, lines] of ROWS) {
  test(`question across a restart | ${label}`, async () => {
    const t = await world(asked);
    try {
      await t.run(after, "start", 50, "lead asks the user", "new life", "restart", 91, "check", 10, "check");
      assert.deepEqual(t.rounds(), rounds, "rounds the lead got");
      assert.deepEqual(await t.lines(), lines, "team log");
    } finally {
      t.cleanup();
    }
  });
}

test("question across a restart | a new session in the same life (no restart) keeps the question", async () => {
  const t = await world("s-1");
  try {
    await t.run("s-2", "start", 50, "lead asks the user", "new life", 41, "check");
    assert.deepEqual(t.rounds(), []);
    assert.deepEqual(await t.lines(), [SKIPPED]);
  } finally {
    t.cleanup();
  }
});

test("question across a restart | `aya status waiting` keeps the session the project file has for the pane", async () => {
  const { rpc } = await import("./helpers/control-rpc.mjs");
  const { startControlServerOn } = await import("../dist-electron/control.js");
  status.__resetAgentStatusForTests();
  const dir = mkdtempSync(join(tmpdir(), "aya-new-life-sock-"));
  const projects = [{ slug: "game", name: "game", directory: dir, tabs: [{ id: "pane-l", presetId: "claude", name: "l", sessionId: "s-7" }, { id: "pane-i", presetId: "claude", name: "i" }] }];
  const stop = startControlServerOn(join(dir, "aya.sock"), { getWindow: () => null, openProject: () => {}, listProjects: async () => projects });
  try {
    for (const terminalId of ["pane-l", "pane-i"]) await rpc(join(dir, "aya.sock"), { type: "status", level: "waiting", text: QUESTION, terminalId, caller: { terminalId } });
    const saved = JSON.parse(readFileSync(join(process.env.AYA_HOME, "agent-waiting.json"), "utf8"));
    assert.equal(saved["pane-l"].session, "s-7");
    assert.equal(saved["pane-i"].session, undefined, "a pane with no known session keeps none");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
    status.__resetAgentStatusForTests();
  }
});
