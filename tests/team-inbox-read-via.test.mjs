// A held message the receiver read with `aya team inbox` is shown as "read via inbox", not as pasted later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";
import { messageDeliveryText } from "../dist-test/team-view.js";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { listTeams } = await import("../dist-electron/team-admin.js");

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

async function setup() {
  const t = teamProject("aya-via-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.setPaused(false);
  const w = { held: { "pane-w": "shows an approval prompt" }, typed: [] };
  const deps = { teamHome: t.teamHome, listProjects: async () => [t.project], deliver: async (_p, text) => void w.typed.push(text), headCommit: async () => null, holdReason: async (pane) => w.held[pane] ?? null };
  const runner = new TeamRunner(deps, () => () => {});
  const send = (pane, role, text) => handleTeamRequest({ type: "team-send", role, text }, pane, deps).catch(() => {});
  const inbox = (pane) => handleTeamRequest({ type: "team-inbox" }, pane, deps);
  const shown = async () => (await listTeams(t.teamHome, t.project))[0].log.map((m) => messageDeliveryText(m));
  return { ...t, store, w, runner, send, inbox, shown };
}

const viaTest = (name, ...args) => {
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

// held report x how the receiver gets it -> what the window says
const ROWS = [
  ["read with the inbox command", async (t) => void (await t.inbox("pane-w")), ["read via inbox"]],
  ["typed by the redelivery once the pane is free", async (t) => ((t.w.held = {}), void (await t.runner.redeliverWaiting())), ["written later (was held: shows an approval prompt)"]],
  ["still waiting", async () => {}, ["waiting in inbox: shows an approval prompt"]],
  ["read with the inbox, the pane then frees", async (t) => (await t.inbox("pane-w"), (t.w.held = {}), void (await t.runner.redeliverWaiting())), ["read via inbox"]],
];
for (const [label, act, want] of ROWS) {
  viaTest(`held report | ${label}`, async (t) => {
    await t.send("pane-l", "worker", "report A");
    await act(t);
    assert.deepEqual(await t.shown(), want);
  });
}

viaTest("two held reports: one read by the inbox, the later one typed", async (t) => {
  await t.send("pane-l", "worker", "report A");
  await t.inbox("pane-w");
  await t.send("pane-l", "worker", "report B");
  t.w.held = {};
  await t.runner.redeliverWaiting();
  assert.deepEqual(await t.shown(), ["read via inbox", "written later (was held: shows an approval prompt)"]);
});

test("messageDeliveryText | the view says it plainly", () => {
  assert.equal(messageDeliveryText({ from: "lead", delivered: true, held: "shows an approval prompt", viaInbox: true }), "read via inbox");
  assert.equal(messageDeliveryText({ from: "lead", delivered: true, held: "shows an approval prompt" }), "written later (was held: shows an approval prompt)");
  assert.equal(messageDeliveryText({ from: "lead", delivered: false, held: "shows an approval prompt", viaInbox: true }), "waiting in inbox: shows an approval prompt");
});

// Aya's own held round is stale: the inbox marks it read without printing it, so the window keeps it "not typed".
for (const [label, act] of [
  ["left alone", async () => {}],
  ["taken by the inbox command", async (t) => void (await t.inbox("pane-w"))],
  ["the pane frees and the redelivery passes", async (t) => ((t.w.held = {}), void (await t.runner.redeliverWaiting()))],
]) {
  viaTest(`Aya's held round | ${label}: still "not typed"`, async (t) => {
    await t.store.append({ from: "aya", to: "worker", commit: null, text: "Round 3: run your round", delivered: false, held: "shows an approval prompt" });
    await act(t);
    assert.deepEqual(await t.shown(), ["not typed: shows an approval prompt"]);
  });
}
