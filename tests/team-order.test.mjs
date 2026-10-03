// Messages reach a role in the order they were sent, and one message is read once: the inbox and the
// redelivery never both hand it over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamProject } from "./helpers/team.mjs";

const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { deliverAndLog, handleTeamRequest } = await import("../dist-electron/team-control.js");

const TEAM = `# ux-review

## Role: lead
Sends to: worker (the next step)
Must not: edit code

## Role: worker
Sends to: lead (the result)
Must not: skip a report

## Role: checker
Sends to: worker (findings)
Must not: edit code

## Lead
lead
`;

async function setup() {
  const t = teamProject("aya-order-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }, { id: "pane-c" }] });
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.assign("checker", "pane-c");
  await store.setPaused(false);
  const w = { held: { "pane-w": "shows an approval prompt" }, typed: [], hooks: [] };
  const deps = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text) => void w.typed.push(text.replace(/^\[team ux-review \| from (\S+) \| \d\d:\d\d\] /, "$1: ")),
    holdReason: async (pane) => {
      const hold = w.held[pane] ?? null;
      for (const hook of w.hooks.splice(0)) await hook(pane);
      return hold;
    },
    headCommit: async () => null,
  };
  const runner = new TeamRunner(deps, () => () => {});
  const send = (from, text, pane) => handleTeamRequest({ type: "team-send", role: "worker", text }, pane, deps).catch((e) => e.message);
  return { ...t, store, w, deps, runner, send };
}

const orderTest = (name, ...args) => {
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

// backlog for the worker x who sends next -> is the new one typed at once?
const ROWS = [
  ["no backlog", null, "pane-l", "typed"],
  ["a held report from the lead", ["lead", "report A"], "pane-c", "waits"],
  ["a held report from the lead", ["lead", "report A"], "pane-l", "waits"],
  ["only Aya's held round", ["aya", "Round 1: go"], "pane-l", "typed"],
];
for (const [name, backlog, from, want] of ROWS) {
  orderTest(`pane free again: ${name}, then a message from ${from}`, async (t) => {
    if (backlog) await t.store.append({ from: backlog[0], to: "worker", commit: null, text: backlog[1], delivered: false, held: "shows an approval prompt" });
    t.w.held = {};
    const out = await t.send(from, "report B", from);
    if (want === "typed") {
      assert.deepEqual(t.w.typed, ["lead: report B".replace("lead", from === "pane-c" ? "checker" : "lead")]);
    } else {
      assert.deepEqual(t.w.typed, [], "an earlier message is still waiting: nothing is typed ahead of it");
      assert.match(out, /earlier message.* waiting.*message \d+ is kept for aya team inbox/);
      assert.equal(await t.runner.redeliverWaiting(), 1);
      assert.equal(await t.runner.redeliverWaiting(), 1);
      assert.deepEqual(t.w.typed.map((x) => x.replace(/^\S+: /, "")), ["report A", "report B"], "in the order sent");
    }
  });
}

orderTest("A held behind an approval, the pane frees, B is sent before the retry: A is typed first", async (t) => {
  assert.match(await t.send("lead", "report A", "pane-l"), /shows an approval prompt/);
  t.w.held = {};
  await t.send("lead", "report B", "pane-l");
  await t.runner.redeliverWaiting();
  await t.runner.redeliverWaiting();
  assert.deepEqual(t.w.typed.map((x) => x.replace(/^\S+: /, "")), ["report A", "report B"]);
});

orderTest("Aya's own message goes ahead of nothing: a round is typed even with a report waiting", async (t) => {
  await t.store.append({ from: "lead", to: "worker", commit: null, text: "report A", delivered: false, held: "x" });
  t.w.held = {};
  const { failure } = await deliverAndLog(t.deps, t.project, t.store, { team: "ux-review", from: "aya", to: "worker", text: "Round 1: go" });
  assert.equal(failure, null);
});

const printed = (out) => (out.match(/report A/g) ?? []).length;

orderTest("the inbox read lands between the redelivery's look and its paste: A is handed over once", async (t) => {
  await t.send("lead", "report A", "pane-l");
  t.w.held = {};
  let inbox = "";
  t.w.hooks.push(async () => void (inbox = (await handleTeamRequest({ type: "team-inbox" }, "pane-w", t.deps)).output));
  await t.runner.redeliverWaiting();
  assert.equal(printed(inbox) + t.w.typed.filter((x) => x.includes("report A")).length, 1, `printed ${JSON.stringify(inbox)}, typed ${JSON.stringify(t.w.typed)}`);
});

for (const [name, order] of [
  ["inbox first", "inbox"],
  ["redelivery first", "redeliver"],
  ["both at once", "both"],
]) {
  orderTest(`A is waiting; ${name}: one of them has it, not both`, async (t) => {
    await t.send("lead", "report A", "pane-l");
    t.w.held = {};
    const read = () => handleTeamRequest({ type: "team-inbox" }, "pane-w", t.deps).then((r) => r.output);
    let out = "";
    if (order === "inbox") (out = await read()), await t.runner.redeliverWaiting();
    if (order === "redeliver") await t.runner.redeliverWaiting(), (out = await read());
    if (order === "both") [out] = await Promise.all([read(), t.runner.redeliverWaiting()]);
    assert.equal(printed(out) + t.w.typed.filter((x) => x.includes("report A")).length, 1, `printed ${JSON.stringify(out)}, typed ${JSON.stringify(t.w.typed)}`);
  });
}
