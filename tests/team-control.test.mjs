// `aya team whoami|send|inbox` through the real CLI and the real control
// server: roles come from the team file, panes from the local assignments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const cli = resolve("bin/aya");
const TEAM = `# ux-review

## Role: tester
Sends to: implementer (findings with proof)
Must not: edit code
Plays the build each round.

## Role: implementer
Sends to: tester
Must not: skip a report
Fixes findings.

## Role: designer
Must not: write code
Draws screens.

## Protocol
One round every 30 minutes.
`;

/** A project with the team file, tester on pane-t, implementer on pane-i. */
async function setup({ writePane, assign = true, holdReason } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aya-team-ctl-"));
  const projectDir = join(root, "game");
  mkdirSync(join(projectDir, ".aya", "teams"), { recursive: true });
  writeFileSync(join(projectDir, ".aya", "teams", "ux-review.md"), TEAM);
  const ayaHome = join(root, "aya-home");
  const store = new TeamStore(teamDir(ayaHome, "game", "ux-review"));
  if (assign) {
    await store.assign("tester", "pane-t");
    await store.assign("implementer", "pane-i");
  }
  const writes = [];
  const socket = join(root, "aya.sock");
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: async () => [
      {
        slug: "game",
        name: "game",
        directory: projectDir,
        tabs: [
          { id: "pane-t", presetId: "claude", name: "Tester" },
          { id: "pane-i", presetId: "claude", name: "Claude Account" },
          { id: "pane-x", presetId: "claude", name: "Other" },
        ],
      },
    ],
    readPane: async () => "",
    writePane: writePane ?? (async (id, data) => void writes.push({ id, data })),
    teamHome: ayaHome,
    headCommit: async () => "a1b2c3d",
    holdReason: holdReason ?? (async () => null),
  });
  const aya = (pane, ...args) =>
    new Promise((done, fail) => {
      const child = spawn(cli, ["team", ...args], {
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AYA_"))),
          AYA_SOCKET: socket,
          AYA_TERMINAL_ID: pane,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", fail);
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  const cleanup = () => {
    stop();
    rmSync(root, { recursive: true, force: true });
  };
  return { aya, writes, store, projectDir, cleanup };
}

test("whoami prints the caller's role, peers, must-not and protocol", async () => {
  const t = await setup();
  try {
    const { status, stdout } = await t.aya("pane-t", "whoami");
    assert.equal(status, 0);
    assert.match(stdout, /team\s+ux-review/);
    assert.match(stdout, /you\s+tester/);
    assert.match(stdout, /sends to\s+implementer: findings with proof/);
    assert.match(stdout, /must not\s+edit code/);
    assert.match(stdout, /Plays the build each round\./);
    assert.match(stdout, /One round every 30 minutes\./);
  } finally {
    t.cleanup();
  }
});

test("whoami from a pane without a role says so", async () => {
  const t = await setup();
  try {
    const { status, stderr } = await t.aya("pane-x", "whoami");
    assert.notEqual(status, 0);
    assert.match(stderr, /no team role/);
  } finally {
    t.cleanup();
  }
});

test("send types a dated, attributed message into the role's pane and presses Enter", async () => {
  const t = await setup();
  try {
    const { status, stdout } = await t.aya("pane-t", "send", "implementer", "round 5 ready");
    assert.equal(status, 0, stdout);
    assert.match(stdout, /written to implementer's pane/);
    assert.equal(t.writes.length, 2);
    assert.equal(t.writes[0].id, "pane-i");
    assert.match(t.writes[0].data, /^\[team ux-review \| from tester \| \d\d:\d\d \| a1b2c3d\] round 5 ready$/);
    assert.deepEqual(t.writes[1], { id: "pane-i", data: "\r" });
    assert.deepEqual(await t.store.unread("implementer"), []);
  } finally {
    t.cleanup();
  }
});

test("send outside the role's send-to list is refused and nothing is typed", async () => {
  const t = await setup();
  try {
    const { status, stderr } = await t.aya("pane-t", "send", "designer", "hi");
    assert.notEqual(status, 0);
    assert.match(stderr, /tester does not send to designer/);
    assert.equal(t.writes.length, 0);
  } finally {
    t.cleanup();
  }
});

test("a role with no pane keeps the message for its inbox", async () => {
  const t = await setup();
  try {
    await t.store.releasePane("pane-i");
    const sent = await t.aya("pane-t", "send", "implementer", "please retest");
    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /implementer: no pane assigned; nothing was typed.*inbox/);
    assert.equal(t.writes.length, 0);
    await t.store.assign("implementer", "pane-i");
    const inbox = await t.aya("pane-i", "inbox");
    assert.match(inbox.stdout, /from tester.*please retest/);
    assert.match((await t.aya("pane-i", "inbox")).stdout, /no unread messages/);
  } finally {
    t.cleanup();
  }
});

test("a pane that does not accept the text keeps the message for its inbox", async () => {
  const t = await setup({ writePane: async () => false });
  try {
    const sent = await t.aya("pane-t", "send", "implementer", "hello");
    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /did not accept.*inbox/);
    assert.equal((await t.store.unread("implementer")).length, 1);
  } finally {
    t.cleanup();
  }
});

test("the definition the user saved wins over later edits to the repo file", async () => {
  const t = await setup();
  try {
    await t.store.saveDefinition(TEAM);
    writeFileSync(
      join(t.projectDir, ".aya", "teams", "ux-review.md"),
      TEAM.replace("Must not: edit code", "Must not: nothing at all"),
    );
    assert.match((await t.aya("pane-t", "whoami")).stdout, /must not\s+edit code/);
  } finally {
    t.cleanup();
  }
});

test("a pane Aya must not type into keeps the message and says why", async () => {
  const t = await setup({ holdReason: async (id) => (id === "pane-i" ? "shows an approval prompt" : null) });
  try {
    const sent = await t.aya("pane-t", "send", "implementer", "round 6");
    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /implementer: shows an approval prompt; nothing was typed.*inbox/);
    assert.equal(t.writes.length, 0);
    assert.equal((await t.store.unread("implementer")).length, 1);
  } finally {
    t.cleanup();
  }
});

test("line breaks in a message cannot submit a second, unattributed turn", async () => {
  const t = await setup();
  try {
    await t.aya("pane-t", "send", "implementer", "line one\rrm -rf /tmp/x\nline three");
    assert.equal(t.writes.length, 2);
    assert.doesNotMatch(t.writes[0].data, /[\r\n\x00-\x1f]/);
    assert.match(t.writes[0].data, /line one rm -rf \/tmp\/x line three$/);
  } finally {
    t.cleanup();
  }
});
