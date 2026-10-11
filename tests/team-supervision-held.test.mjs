// The quiet-team round tells the lead who waits on whom: a reply still held in the receiver's inbox is no answer.

process.env.AYA_E2E_TEAM_MINUTE_MS = String(TEST_TEAM_MINUTE_MS);
process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-sup-held-home-"));

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
  const { teamHome, project, cleanup } = teamProject("aya-sup-held-", { teamFile: TEAM, tabs: [{ id: "pane-t" }, { id: "pane-i" }] });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("tester", "pane-t");
  await store.assign("implementer", "pane-i");
  const w = { holds: {}, typed: [], jobs: [], now: Date.now() };
  w.deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void w.typed.push({ pane, text }),
    holdReason: async (pane) => w.holds[pane] ?? null,
    headCommit: async () => "c0",
  };
  w.runner = new TeamRunner(w.deps, (fn) => (w.jobs.push(fn), () => {}), () => w.now, () => {});
  const send = (from, to, text) => handleTeamRequest({ type: "team-send", role: to, text }, from, w.deps).catch(() => {});
  const roundText = () => w.typed.filter((t) => t.pane === "pane-t" && /Aya round \d+:/.test(t.text)).at(-1)?.text ?? "";
  return { w, store, send, roundText, cleanup: () => (w.runner.stopAll(), cleanup()) };
}

const REPLY = {
  "held in the lead's inbox": { act: async () => {}, lead: /tester waits for implementer/, implementer: /implementer waits for tester/ },
  "typed later by the redelivery": { act: async (t) => ((t.w.holds = {}), void (await t.w.runner.redeliverWaiting())), lead: null, implementer: /implementer waits for tester/ },
  "read via the lead's inbox": { act: async (t) => void (await handleTeamRequest({ type: "team-inbox" }, "pane-t", t.w.deps)), lead: null, implementer: /implementer waits for tester/ },
};

for (const [kind, waitMs, first] of [["quiet round", 91_000, /Aya round 1: no progress since/], ["stall round", 181_000, /stalled: no change to the repo/]])
for (const [reply, { act, lead, implementer }] of Object.entries(REPLY)) {
  test(`${kind} | the implementer's reply ${reply} -> ${lead ? "the lead still waits" : "the lead's question is answered"}`, async () => {
    const t = await world();
    try {
      await t.w.runner.start("game", "ux-review");
      await t.send("pane-t", "implementer", "question: does the timer test pass on CI?");
      t.w.holds["pane-t"] = "shows an approval prompt";
      await t.send("pane-i", "tester", "answer: it fails on CI, details in notes/timer.md");
      await act(t);
      t.w.holds = {};
      t.w.now += waitMs;
      await t.w.jobs.at(-1)();
      const text = t.roundText();
      assert.match(text, first);
      if (lead) assert.match(text, lead);
      else assert.doesNotMatch(text, /tester waits for implementer/);
      assert.match(text, implementer);
    } finally {
      t.cleanup();
    }
  });
}
