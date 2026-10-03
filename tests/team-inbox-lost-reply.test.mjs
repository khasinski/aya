// A CLI gone before `aya team inbox` replies (its tool call killed, the pane closed) never printed the messages:
// they stay unread.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rpc } from "./helpers/control-rpc.mjs";
import { teamProject } from "./helpers/team.mjs";
import { messageDeliveryText } from "../dist-test/team-view.js";

const { startControlServerOn } = await import("../dist-electron/control.js");
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

/** A CLI that sends its request and is gone before any reply: its socket closes at once. */
function goneBeforeReply(socket, frame) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socket);
    c.on("error", reject);
    c.on("connect", () => c.end(`${JSON.stringify(frame)}\n`, () => c.destroy()));
    c.on("close", () => resolve());
  });
}

async function world() {
  const t = teamProject("aya-inbox-lost-", { teamFile: TEAM, tabs: [{ id: "pane-l" }, { id: "pane-w" }] });
  const dir = mkdtempSync(join(tmpdir(), "aya-inbox-lost-sock-"));
  const socket = join(dir, "aya.sock");
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("lead", "pane-l");
  await store.assign("worker", "pane-w");
  await store.setPaused(false);
  const w = { held: { "pane-w": "shows an approval prompt" }, typed: [] };
  const deps = { teamHome: t.teamHome, listProjects: async () => [t.project], deliver: async (pane, text) => void w.typed.push({ pane, text }), headCommit: async () => null, holdReason: async (pane) => w.held[pane] ?? null };
  const runner = new TeamRunner(deps, () => () => {});
  const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {}, listProjects: deps.listProjects, team: deps, teamRunner: runner });
  const frame = { type: "team-inbox", caller: { terminalId: "pane-w" } };
  return {
    store,
    w,
    runner,
    send: (text) => handleTeamRequest({ type: "team-send", role: "worker", text }, "pane-l", deps).catch(() => {}),
    inbox: async () => (await rpc(socket, frame)).output,
    inboxGone: async () => {
      await goneBeforeReply(socket, frame);
      // the server's write to the closed socket fails after the handler; let it settle
      await new Promise((r) => setTimeout(r, 150));
    },
    shown: async () => (await listTeams(t.teamHome, t.project))[0].log.filter((m) => m.from === "lead").map((m) => messageDeliveryText(m)),
    cleanup: () => {
      stop();
      runner.stopAll();
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const inboxTest = (name, ...args) => {
  const fn = args.pop();
  test(name, async () => {
    const w = await world(...args);
    try {
      await fn(w);
    } finally {
      w.cleanup();
    }
  });
};

const WAITING = {
  "one held report": ["report A"],
  "two held reports": ["report A", "report B"],
};

for (const [waiting, texts] of Object.entries(WAITING)) {
  inboxTest(`inbox | ${waiting} | the CLI reads the reply -> printed once, the next inbox is empty, shown read via inbox`, async (w) => {
    for (const text of texts) await w.send(text);
    const first = await w.inbox();
    for (const text of texts) assert.match(first, new RegExp(text));
    assert.equal(await w.inbox(), "no unread messages\n");
    assert.deepEqual(await w.shown(), texts.map(() => "read via inbox"));
  });

  inboxTest(`inbox | ${waiting} | the CLI is gone before the reply -> the next inbox prints them, not shown as read`, async (w) => {
    for (const text of texts) await w.send(text);
    await w.inboxGone();
    assert.deepEqual(await w.shown(), texts.map(() => "waiting in inbox: shows an approval prompt"), "the window does not say read");
    const next = await w.inbox();
    for (const text of texts) assert.match(next, new RegExp(text), "the role still gets it");
  });

  inboxTest(`inbox | ${waiting} | the CLI is gone before the reply, then the pane frees -> the redelivery types the first`, async (w) => {
    for (const text of texts) await w.send(text);
    await w.inboxGone();
    w.w.held = {};
    await w.runner.redeliverWaiting();
    assert.ok(w.w.typed.some((x) => x.pane === "pane-w" && x.text.includes(texts[0])), "typed into the worker's pane");
  });
}

inboxTest("inbox | nothing waiting | the CLI is gone before the reply -> nothing changes", async (w) => {
  await w.inboxGone();
  assert.equal(await w.inbox(), "no unread messages\n");
});

inboxTest("inbox | the reply is lost after the role read on (a later inbox or typing passed the mark) -> giving back lowers nothing", async (w) => {
  await w.send("report A");
  const { taken, giveBack } = await w.store.takeUnread("worker");
  assert.equal(taken.length, 1);
  await w.send("report B");
  const [b] = await w.store.unread("worker");
  await w.store.markRead("worker", b.id);
  await giveBack();
  assert.deepEqual(await w.store.unread("worker"), [], "a mark that moved on stays");
});
