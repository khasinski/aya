// `aya team whoami|send|inbox` through the real CLI and the real control
// server: roles come from the team file, panes from the local assignments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";

const { deliverTeamMessage, startControlServerOn } = await import("../dist-electron/control.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { NO_PANE_HOLD, handleTeamRequest, typedTeamMessage } = await import("../dist-electron/team-control.js");

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
  const listProjects = async () => [
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
  ];
  const write = writePane ?? (async (id, data) => void writes.push({ id, data }));
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects,
    readPane: async () => "",
    writePane: write,
    team: {
      teamHome: ayaHome,
      listProjects,
      deliver: (terminalId, text) => deliverTeamMessage(write, terminalId, text),
      headCommit: async () => "a1b2c3d",
      holdReason: holdReason ?? (async () => null),
    },
  });
  const aya = (pane, ...args) =>
    new Promise((done, fail) => {
      const child = spawn(cli, ["team", ...args], {
        env: {
          ...envWithoutAya(),
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
    // A bracketed paste: Codex takes fast raw typing for a paste and swallows the
    // Enter that follows a long one (measured: 600+ chars at 150 ms).
    assert.match(t.writes[0].data, /^\x1b\[200~\[team ux-review \| from tester \| \d\d:\d\d \| a1b2c3d\] round 5 ready\x1b\[201~$/);
    assert.equal(t.writes[1].data, "\r");
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
    assert.equal((await t.store.log()).at(-1).held, "no pane assigned");
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
    assert.match(sent.stderr, /implementer: did not take the text \(it may have exited\); nothing was typed.*inbox/);
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
    const body = t.writes[0].data.replace(/^\x1b\[200~|\x1b\[201~$/g, "");
    assert.doesNotMatch(body, /[\r\n\x00-\x1f]/);
    assert.match(body, /line one rm -rf \/tmp\/x line three$/);
  } finally {
    t.cleanup();
  }
});

test("the pasted line carries no control bytes, header included", async () => {
  const { deliverAndLog } = await import("../dist-electron/team-control.js");
  const root = mkdtempSync(join(tmpdir(), "aya-team-ctl-"));
  try {
    const store = new TeamStore(join(root, "team"));
    await store.assign("implementer", "pane-i");
    const typed = [];
    const deps = {
      deliver: async (_pane, text) => void typed.push(text),
      holdReason: async () => null,
      headCommit: async () => "abc\x1b[201~\r",
    };
    const { failure } = await deliverAndLog(deps, { directory: root }, store, {
      team: "ux\x1b[201~\rrm -rf ~\r",
      from: "tester\x07",
      to: "implementer",
      text: "hi",
    });
    assert.equal(failure, null);
    assert.equal(typed.length, 1);
    assert.doesNotMatch(typed[0], /[\x00-\x1f\x7f]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a typed team message is its header and text on one line; a role with no pane is held", () => {
  const at = new Date(2026, 0, 2, 9, 5).toISOString();
  assert.equal(typedTeamMessage("ux-review", "tester", at, "abc1234", "a\nb\x1b c "), "[team ux-review | from tester | 09:05 | abc1234] a b  c");
  assert.equal(typedTeamMessage("ux-review", "aya", at, null, "hi"), "[team ux-review | from aya | 09:05] hi");
  assert.equal(NO_PANE_HOLD, "no pane assigned");
});

test("a pane with no role, or a role the saved team no longer has, gets the one message", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-team-member-"));
  try {
    const directory = join(root, "game");
    mkdirSync(join(directory, ".aya", "teams"), { recursive: true });
    writeFileSync(join(directory, ".aya", "teams", "ux-review.md"), TEAM);
    const teamHome = join(root, "aya-home");
    await new TeamStore(teamDir(teamHome, "game", "ux-review")).assign("ghost", "pane-g");
    const project = { slug: "game", name: "game", directory, tabs: [{ id: "pane-x" }, { id: "pane-g" }] };
    const deps = { teamHome, listProjects: async () => [project] };
    const message = "this pane has no team role; assign one from the tab menu";
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, "pane-x", deps), { message });
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, "pane-g", deps), { message });
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, "pane-y", deps), { message: "this pane belongs to no open project" });
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, undefined, deps), { message: "run aya team inside an Aya pane" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
