// The redelivery pastes a waiting report and a prompt appears before Enter: the window and the draft note say
// "typed, Enter withheld".

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";
import { messageDeliveryText } from "../dist-test/team-view.js";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest, PaneHeldError, TextPastedError } = await import("../dist-electron/team-control.js");
const { listTeams } = await import("../dist-electron/team-admin.js");
const { HOLD_DRAFT } = await import("../dist-electron/pane-holds.js");

const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report

## Lead
lead
`;

async function setup(failure) {
  const t = teamProject("aya-withheld-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.setPaused(false);
  const w = { hold: "shows an approval prompt", failure, typed: [] };
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (_p, text) => {
      if (w.failure) throw w.failure;
      w.typed.push(text);
    },
    headCommit: async () => null,
    holdReason: async () => w.hold,
  };
  const runner = new TeamRunner(deps, () => () => {});
  const send = (pane, role, text) => handleTeamRequest({ type: "team-send", role, text }, pane, deps).then((r) => r.output, (e) => e.message);
  const shown = async () => (await listTeams(t.teamHome, t.project))[0].log.map((m) => messageDeliveryText(m));
  return { ...t, store, w, runner, send, shown };
}

// error the redelivery's paste meets x what the window says afterwards
const ROWS = [
  ["a prompt appeared before Enter (text in the composer)", new PaneHeldError("a prompt appeared after the text was typed", true), "typed, Enter withheld: a prompt appeared after the text was typed", true],
  ["Enter did not go through (text pasted)", new TextPastedError("pasted"), "typed, but Enter did not go through (the pane may have exited); the text may still sit in its composer", true],
  ["a prompt appeared first, nothing typed", new PaneHeldError("shows an approval prompt", false), "waiting in inbox: shows an approval prompt", false],
];
for (const [label, failure, want, kept] of ROWS) {
  test(`redelivery | ${label}`, async () => {
    const t = await setup(null);
    try {
      await t.send("pane-l", "worker", "report A");
      t.w.hold = null;
      t.w.failure = failure;
      await t.runner.redeliverWaiting();
      assert.deepEqual(await t.shown(), [want]);
      t.w.failure = null;
      assert.equal(await t.runner.redeliverWaiting(), kept ? 0 : 1);
    } finally {
      t.cleanup();
    }
  });
}

test("redelivery | the next message to a pane with a withheld report names it as the draft", async () => {
  const t = await setup(null);
  try {
    await t.send("pane-l", "worker", "report A");
    t.w.hold = null;
    t.w.failure = new PaneHeldError("a prompt appeared after the text was typed", true);
    await t.runner.redeliverWaiting();
    t.w.failure = null;
    t.w.hold = HOLD_DRAFT;
    const out = await t.send("pane-l", "worker", "report B");
    assert.match(out, /has text the user is typing; it may be message #1 from lead, typed there with its Enter withheld: submit or clear it/);
  } finally {
    t.cleanup();
  }
});
