// `aya team whoami|send|inbox` through the real CLI and the real control
// server: roles come from the team file, panes from the local assignments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";
import { envWithoutAya } from "./helpers/env.mjs";
import { teamProject } from "./helpers/team.mjs";

const { deliverTeamMessage, startControlServerOn } = await import("../dist-electron/control.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { deliverAndLog, handleTeamRequest, typedTeamMessage } = await import("../dist-electron/team-control.js");
const { NO_PANE_HOLD } = await import("../dist-electron/pane-holds.js");

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
  const tabs = [
    { id: "pane-t", presetId: "claude", name: "Tester" },
    { id: "pane-i", presetId: "claude", name: "Claude Account" },
    { id: "pane-x", presetId: "claude", name: "Other" },
  ];
  const { root, directory: projectDir, teamHome, project, cleanup: removeRoot } = teamProject("aya-team-ctl-", { teamFile: TEAM, tabs });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  if (assign) {
    await store.assign("tester", "pane-t");
    await store.assign("implementer", "pane-i");
  }
  const writes = [];
  const socket = join(root, "aya.sock");
  const listProjects = async () => [project];
  const write = writePane ?? (async (id, data) => void writes.push({ id, data }));
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects,
    readPane: async () => "",
    writePane: write,
    team: {
      teamHome,
      listProjects,
      deliver: (terminalId, text) => deliverTeamMessage(write, terminalId, text, holdReason),
      headCommit: async () => "a1b2c3d",
      holdReason: holdReason ?? (async () => null),
    },
  });
  const ayaIn = (shell, pane, ...args) =>
    new Promise((done, fail) => {
      const child = spawn(shell, [cli, "team", ...args], {
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
  const aya = (pane, ...args) => ayaIn("/bin/sh", pane, ...args);
  const cleanup = () => {
    stop();
    removeRoot();
  };
  return { aya, ayaIn, writes, store, projectDir, cleanup };
}

const controlTest = (name, ...args) => {
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

controlTest("whoami prints the caller's role, peers, must-not and protocol", async (t) => {
  const { status, stdout } = await t.aya("pane-t", "whoami");
  assert.equal(status, 0);
  assert.match(stdout, /team\s+ux-review/);
  assert.match(stdout, /you\s+tester/);
  assert.match(stdout, /sends to\s+implementer: findings with proof/);
  assert.match(stdout, /must not\s+edit code/);
  assert.match(stdout, /Plays the build each round\./);
  assert.match(stdout, /One round every 30 minutes\./);
});

controlTest("whoami from a pane without a role says so", async (t) => {
  const { status, stderr } = await t.aya("pane-x", "whoami");
  assert.notEqual(status, 0);
  assert.match(stderr, /no team role/);
});

controlTest("send types a dated, attributed message into the role's pane and presses Enter", async (t) => {
  const { status, stdout } = await t.aya("pane-t", "send", "implementer", "round 5 ready");
  assert.equal(status, 0, stdout);
  assert.match(stdout, /written to implementer's pane/);
  assert.equal(t.writes.length, 2);
  assert.equal(t.writes[0].id, "pane-i");
  // A bracketed paste: Codex takes fast raw typing for a paste and swallows the
  // Enter that follows a long one (measured: 600+ chars at 150 ms).
  assert.match(t.writes[0].data, /^\x1b\[200~\[team ux-review \| from tester \| \d\d:\d\d \| a1b2c3d\] round 5 ready\x1b\[201~$/);
  assert.deepEqual(t.writes[1], { id: "pane-i", data: "\r" });
  assert.deepEqual(await t.store.unread("implementer"), []);
});

for (const shell of CLI_SHELLS) {
  controlTest(`through the real control server: send, whoami and a refused send behave alike (${shell})`, shellOptions(shell), async (t) => {
    const sent = await t.ayaIn(shell, "pane-t", "send", "implementer", "round", "9");
    assert.equal(sent.status, 0, sent.stderr);
    assert.match(t.writes[0].data, /round 9\x1b\[201~$/);
    assert.match((await t.ayaIn(shell, "pane-t", "whoami")).stdout, /tester/);
    const refused = await t.ayaIn(shell, "pane-t", "send", "designer", "hi");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /tester does not send to designer/);
    const noRole = await t.ayaIn(shell, "pane-t", "send");
    assert.equal(noRole.status, 1, "dash once exited 2 here");
    assert.equal(t.writes.length, 2, "nothing more was typed");
  });
}

controlTest("send outside the role's send-to list is refused and nothing is typed", async (t) => {
  const { status, stderr } = await t.aya("pane-t", "send", "designer", "hi");
  assert.notEqual(status, 0);
  assert.match(stderr, /tester does not send to designer/);
  assert.equal(t.writes.length, 0);
});

controlTest("a role with no pane keeps the message for its inbox", async (t) => {
  await t.store.releasePane("pane-i");
  const sent = await t.aya("pane-t", "send", "implementer", "please retest");
  assert.notEqual(sent.status, 0);
  assert.match(sent.stderr, /implementer: no pane assigned; nothing was typed.*inbox/);
  assert.equal((await t.store.annotatedLog()).at(-1).held, "no pane assigned");
  assert.equal(t.writes.length, 0);
  await t.store.assign("implementer", "pane-i");
  const inbox = await t.aya("pane-i", "inbox");
  assert.match(inbox.stdout, /from tester.*please retest/);
  assert.match((await t.aya("pane-i", "inbox")).stdout, /no unread messages/);
});

controlTest("a pane that does not accept the text keeps the message for its inbox", { writePane: async () => false }, async (t) => {
  const sent = await t.aya("pane-t", "send", "implementer", "hello");
  assert.notEqual(sent.status, 0);
  assert.match(sent.stderr, /implementer: did not take the text \(it may have exited\); nothing was typed.*inbox/);
  assert.equal((await t.store.unread("implementer")).length, 1);
});

controlTest("the definition the user saved wins over later edits to the repo file", async (t) => {
  await t.store.saveDefinition(TEAM);
  writeFileSync(
    join(t.projectDir, ".aya", "teams", "ux-review.md"),
    TEAM.replace("Must not: edit code", "Must not: nothing at all"),
  );
  assert.match((await t.aya("pane-t", "whoami")).stdout, /must not\s+edit code/);
});

controlTest("a pane Aya must not type into keeps the message and says why", { holdReason: async (id) => (id === "pane-i" ? "shows an approval prompt" : null) }, async (t) => {
  const sent = await t.aya("pane-t", "send", "implementer", "round 6");
  assert.notEqual(sent.status, 0);
  assert.match(sent.stderr, /implementer: shows an approval prompt; nothing was typed.*inbox/);
  assert.equal(t.writes.length, 0);
  assert.equal((await t.store.unread("implementer")).length, 1);
});

controlTest("line breaks in a message cannot submit a second, unattributed turn", async (t) => {
  await t.aya("pane-t", "send", "implementer", "line one\rrm -rf /tmp/x\nline three");
  assert.equal(t.writes.length, 2);
  const body = t.writes[0].data.replace(/^\x1b\[200~|\x1b\[201~$/g, "");
  assert.doesNotMatch(body, /[\r\n\x00-\x1f]/);
  assert.match(body, /line one rm -rf \/tmp\/x line three$/);
});

test("the pasted line carries no control bytes, header included", async () => {
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
  assert.equal(typedTeamMessage("ux-review", "aya", at, null, "a\x7fb"), "[team ux-review | from aya | 09:05] a b");
  assert.equal(NO_PANE_HOLD, "no pane assigned");
});

test("a pane with no role, or a role the saved team no longer has, gets the one message", async () => {
  const { teamHome, project, cleanup } = teamProject("aya-team-member-", { teamFile: TEAM, tabs: [{ id: "pane-x" }, { id: "pane-g" }] });
  try {
    await new TeamStore(teamDir(teamHome, "game", "ux-review")).assign("ghost", "pane-g");
    const deps = { teamHome, listProjects: async () => [project] };
    const message = "this pane has no team role; assign one from the tab menu";
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, "pane-x", deps), { message });
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, "pane-g", deps), { message });
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, "pane-y", deps), { message: "this pane belongs to no open project" });
    await assert.rejects(handleTeamRequest({ type: "team-whoami" }, undefined, deps), { message: "run aya team inside an Aya pane" });
  } finally {
    cleanup();
  }
});

controlTest("whoami of a role that sends to nobody says so", async (t) => {
  await t.store.assign("designer", "pane-x");
  assert.match((await t.aya("pane-x", "whoami")).stdout, /\nsends to  \(nobody\)\n/);
});

controlTest("inbox shows every waiting message once, then none", async (t) => {
  await t.store.releasePane("pane-i");
  await t.aya("pane-t", "send", "implementer", "first");
  await t.aya("pane-t", "send", "implementer", "second");
  await t.store.assign("implementer", "pane-i");
  const inbox = (await t.aya("pane-i", "inbox")).stdout;
  assert.match(inbox, /^#1 .*first\n#2 .*second\n$/);
  assert.equal((await t.aya("pane-i", "inbox")).stdout, "no unread messages\n");
});

test("the hold is asked again once the pane lock is held, before anything is typed", async () => {
  const { PaneHeldError } = await import("../dist-electron/team-control.js");
  const writes = [];
  const write = async (id, data) => void writes.push(data);
  // Held from the start: nothing is written.
  await assert.rejects(
    deliverTeamMessage(write, "pane-a", "hi", async () => "shows an approval prompt"),
    (err) => err instanceof PaneHeldError && err.reason === "shows an approval prompt",
  );
  assert.equal(writes.length, 0);
  // A send queued behind another sees the prompt that one raised with its Enter.
  let prompt = null;
  const typed = [];
  const raising = async (id, data) => {
    typed.push(data);
    if (data === "\r") prompt = "shows an approval prompt";
  };
  const first = deliverTeamMessage(raising, "pane-b", "one", async () => prompt);
  const second = deliverTeamMessage(raising, "pane-b", "two", async () => prompt);
  await first;
  await assert.rejects(second, (err) => err instanceof PaneHeldError);
  assert.equal(typed.length, 2, "the second message typed nothing");
});

test("an aya-approval prompt drawn after the paste keeps its wording in the withheld-Enter reason and the log", async () => {
  const { HOLD_APPROVE_AYA } = await import("../dist-electron/pane-holds.js");
  let asked = 0;
  const t = await setup({ holdReason: async () => (++asked >= 3 ? HOLD_APPROVE_AYA : null) });
  try {
    const sent = await t.aya("pane-t", "send", "implementer", "round 7");
    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, new RegExp(`implementer: ${HOLD_APPROVE_AYA}; it appeared after the text was typed; text left in the composer, Enter not sent`));
    const entry = (await t.store.annotatedLog()).at(-1);
    assert.equal(entry.typedOnly, true);
    assert.ok(entry.held.startsWith(HOLD_APPROVE_AYA));
  } finally {
    t.cleanup();
  }
});

test("a prompt that appears after the text is typed stops the Enter and the message is not resent", async () => {
  let asked = 0;
  // roleHold, the guard, then the check before Enter: the prompt shows up on the third.
  const t = await setup({ holdReason: async () => (++asked >= 3 ? "shows an approval prompt" : null) });
  try {
    const sent = await t.aya("pane-t", "send", "implementer", "round 7");
    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /implementer: shows an approval prompt; it appeared after the text was typed; text left in the composer, Enter not sent; message \d+ is not resent/);
    assert.equal(t.writes.length, 1, "only the paste was written");
    assert.ok(t.writes[0].data.includes("round 7"));
    assert.deepEqual(await t.store.unread("implementer"), []);
    const entry = (await t.store.annotatedLog()).at(-1);
    assert.equal(entry.delivered, true);
    assert.equal(entry.typedOnly, true, "the log says the Enter was withheld");
    assert.match(entry.held, /appeared after the text was typed/);
  } finally {
    t.cleanup();
  }
});

test("a pane held by the time deliver runs logs the message as held, not failed", async () => {
  const { PaneHeldError } = await import("../dist-electron/team-control.js");
  const root = mkdtempSync(join(tmpdir(), "aya-team-ctl-"));
  try {
    const store = new TeamStore(join(root, "team"));
    await store.assign("implementer", "pane-i");
    const deps = {
      deliver: async () => {
        throw new PaneHeldError("shows an approval prompt");
      },
      holdReason: async () => null,
      headCommit: async () => null,
    };
    const { failure, entry } = await deliverAndLog(deps, { directory: root }, store, {
      team: "ux-review",
      from: "tester",
      to: "implementer",
      text: "hi",
    });
    assert.equal(failure, "shows an approval prompt");
    assert.equal(entry.held, "shows an approval prompt");
    assert.equal((await store.unread("implementer")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a role that floods its peers is refused for the rest of the minute", async () => {
  const { TEAM_SENDS_PER_MINUTE } = await import("../dist-electron/team-control.js");
  const t = await setup();
  try {
    for (let i = 0; i < TEAM_SENDS_PER_MINUTE; i++) {
      await t.store.append({ from: "tester", to: "implementer", commit: null, text: `m${i}`, delivered: true });
    }
    const sent = await t.aya("pane-t", "send", "implementer", "one more");
    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /sent 10 messages in the last minute; nothing was sent/);
    assert.equal(t.writes.length, 0);
  } finally {
    t.cleanup();
  }
});

const HOSTILE = `hi \x1b[31m RED \x1b]0;title\x07 ‮evil​‍‍\u{E0041} ok`;
// Anything a terminal or a reader could act on or not see, the payload's zero-width joiners included.
const HIDDEN_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

controlTest("a held message reaches the receiver's pane through the inbox without control or hidden characters", { holdReason: async (pane) => (pane === "pane-t" ? "busy" : null) }, async (t) => {
  const sent = await t.aya("pane-i", "send", "tester", HOSTILE);
  assert.equal(sent.status, 1);
  const { stdout } = await t.aya("pane-t", "inbox");
  assert.match(stdout, /RED/);
  assert.match(stdout, /ok\n$/);
  assert.doesNotMatch(stdout.replace(/\n$/, ""), HIDDEN_OR_CONTROL, JSON.stringify(stdout));
  assert.equal((await t.store.log())[0].text, "hi  [31m RED  ]0;title  evil ok");
});

test("the next message to a role with a typed-but-unsent message says a draft is waiting in its pane", async () => {
  let hold = null;
  let asked = 0;
  const t = await setup({ holdReason: async () => hold ?? (++asked >= 3 ? "shows an approval prompt" : null) });
  try {
    await t.aya("pane-t", "send", "implementer", "round 7");
    hold = "has text the user is typing";
    const next = await t.aya("pane-t", "send", "implementer", "round 8");
    assert.notEqual(next.status, 0);
    assert.match(next.stderr, /has text the user is typing; it may be message #\d+ from tester, typed there with its Enter withheld: submit or clear it/);
    assert.match(next.stderr, /nothing was typed/);
    assert.doesNotMatch(next.stderr, /is typed there/, "the user may have submitted it and typed a new draft since");
    hold = null;
    asked = -Infinity;
    const other = await t.aya("pane-t", "send", "implementer", "round 9");
    // Round 8 is still waiting in the inbox: round 9 follows it instead of overtaking it, and there is no draft note.
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /earlier message #\d+ for it is still waiting/);
    assert.doesNotMatch(other.stderr, /typed there with its Enter withheld/, "no draft, no note");
  } finally {
    t.cleanup();
  }
});

controlTest("an entry already stored raw is cleaned on the way out of the inbox, sender and team included", async (t) => {
  await t.store.append({ from: "impl\x1b]0;x\x07\u202E", to: "tester", commit: null, text: HOSTILE, delivered: false, held: "busy" });
  const { stdout } = await t.aya("pane-t", "inbox");
  assert.doesNotMatch(stdout.replace(/\n$/, ""), HIDDEN_OR_CONTROL, JSON.stringify(stdout));
});

test("a team's hold is the host's, else the launch mode's; the launch mode is not read while the host holds", async () => {
  const { withLaunchHolds } = await import("../dist-electron/team-control.js");
  let reads = 0;
  const hold = withLaunchHolds(
    async (pane) => (pane === "busy" ? "shows an approval prompt" : null),
    async (pane) => (reads++, pane === "busy" || pane === "sandboxed" ? "can't reach Aya: Codex sandbox workspace-write blocks the socket" : null),
  );
  assert.equal(await hold("busy"), "shows an approval prompt");
  assert.equal(reads, 0);
  assert.equal(await hold("sandboxed"), "can't reach Aya: Codex sandbox workspace-write blocks the socket");
  assert.equal(await hold("free"), null);
});

test("logTyped: text left in the composer without its Enter is logged as reached, not owed again", async () => {
  const { logTyped } = await import("../dist-electron/team-control.js");
  const { teamHome, cleanup } = teamProject("aya-team-logtyped-", { teamFile: TEAM });
  try {
    const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
    const typed = { commit: null, failure: "shows an approval prompt", typed: true, afterEnter: false, unseen: null, reached: true };
    const entry = await logTyped(store, { from: "aya", to: "tester", text: "round 3" }, typed);
    assert.deepEqual([entry.delivered, entry.held, entry.typedOnly], [true, "shows an approval prompt", true]);
  } finally {
    cleanup();
  }
});
