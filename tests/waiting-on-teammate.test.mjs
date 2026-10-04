// `aya status waiting --on <role>`: a team role waits on a teammate, which is the team's to answer, not the user's.
// Plain `aya status waiting` stays the question to the user (red dot, attention, notification, held rounds).
// Tables: status x pane in a team or not x what is shown (dot, bell, attention count, team row, digest line).

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-waiting-on-home-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamProject } from "./helpers/team.mjs";

const status = await import("../dist-electron/agent-status.js");
const { recordAgentStatus, agentWaitingSince, teammateWaits, outstandingWaiting, onStatusPushed } = status;
const { startControlServerOn } = await import("../dist-electron/control.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
const { handleTeamRequest } = await import("../dist-electron/team-control.js");
const { roundDigest, digestOneLine } = await import("../dist-electron/team-digest.js");
const { applyReportedStatus, clearedTerminalStatus } = await import("../dist-test/pty-event-reducer.js");
const { attentionFor, isActionableLevel, projectBadgeLevel } = await import("../dist-test/attention.js");
const { roleStatus, leadWaitingLine, waitingPanesOf } = await import("../dist-test/team-view.js");

const HOOK = "hook";
const ON = "tester";

// ---- What agent-status records ----------------------------------------------------------------------------------

const BEFORE = {
  none: () => {},
  question: (p) => recordAgentStatus(p, "waiting", 1000, "need the staging password"),
  "waits on tester": (p) => recordAgentStatus(p, "waiting", 1000, "answer on the adapter test", undefined, undefined, ON),
  done: (p) => recordAgentStatus(p, "done", 1000, "Build passed"),
};
const ACTION = {
  "agent: waiting --on tester": (p) => recordAgentStatus(p, "waiting", 5000, "x", undefined, undefined, ON),
  "agent: waiting": (p) => recordAgentStatus(p, "waiting", 5000, "x"),
  "agent: done": (p) => recordAgentStatus(p, "done", 5000, "x"),
  "agent: clear": (p) => recordAgentStatus(p, "clear", 5000),
  "hook: PostToolUse (the aya call itself)": (p) => recordAgentStatus(p, "active", 5000, "x", HOOK),
  "hook: Stop": (p) => recordAgentStatus(p, "done", 5000, "x", HOOK),
  "hook: Notification": (p) => recordAgentStatus(p, "waiting", 5000, "x", HOOK),
  "tester's message typed": (p) => (status.teammateAnswered(p, ON, 5000) ? { level: "clear" } : null),
  "another role's message typed": (p) => (status.teammateAnswered(p, "leader", 5000) ? { level: "clear" } : null),
};
// [before, action, what the windows are told (null: nothing), question to the user after, waits on whom after]
const ROWS = [
  ["none", "agent: waiting --on tester", "waiting-on", false, ON],
  ["none", "agent: waiting", "waiting", true, null],
  ["none", "hook: Notification", "done", false, null],
  ["none", "tester's message typed", null, false, null],
  ["question", "agent: waiting --on tester", "waiting-on", false, ON],
  ["question", "hook: PostToolUse (the aya call itself)", null, true, null],
  ["question", "tester's message typed", null, true, null],
  ["waits on tester", "agent: waiting --on tester", "waiting-on", false, ON],
  ["waits on tester", "agent: waiting", "waiting", true, null],
  ["waits on tester", "agent: done", "done", false, null],
  ["waits on tester", "agent: clear", "clear", false, null],
  ["waits on tester", "hook: PostToolUse (the aya call itself)", null, false, ON],
  ["waits on tester", "hook: Stop", null, false, ON],
  ["waits on tester", "hook: Notification", null, false, ON],
  ["waits on tester", "tester's message typed", "clear", false, null],
  ["waits on tester", "another role's message typed", null, false, ON],
  ["done", "agent: waiting --on tester", "waiting-on", false, ON],
  ["done", "tester's message typed", null, false, null],
];

for (const [before, action, windows, asked, on] of ROWS) {
  test(`status | ${before} -> ${action}`, () => {
    const pane = `pane-${before}-${action}`;
    BEFORE[before](pane);
    const update = ACTION[action](pane);
    assert.equal(update?.level ?? null, windows, "what the windows are told");
    assert.equal(agentWaitingSince(pane) !== null, asked, "a question to the user");
    assert.equal(pane in outstandingWaiting(), asked, "kept as a question (agent-waiting.json, the rounds' hold)");
    assert.equal(teammateWaits()[pane]?.on ?? null, on, "a wait on a teammate");
    if (windows === "waiting-on") assert.equal(update.on, ON, "the windows are told whom");
  });
}

test("status | the tester's answer is pushed to the windows as a clear", () => {
  const told = [];
  onStatusPushed((u) => told.push(u));
  recordAgentStatus("pane-push", "waiting", 1000, "answer on the adapter test", undefined, undefined, ON);
  status.teammateAnswered("pane-push", ON, 2000);
  assert.deepEqual(told, [{ terminalId: "pane-push", level: "clear", updatedAt: 2000 }]);
});

// ---- The control server: --on in a team or not ------------------------------------------------------------------

const TEAM = `# ux-review

## Role: leader
Sends to: implementer (tasks), tester (what to check)
Must not: edit code

## Role: implementer
Sends to: leader (results), tester (what changed)
Must not: skip a report

## Role: tester
Sends to: implementer (failing tests)
Must not: change the code to pass a test

## Lead
leader
`;

async function teamWorld() {
  const tabs = [{ id: "pane-l" }, { id: "pane-i" }, { id: "pane-t" }, { id: "pane-solo" }];
  const { teamHome, project, cleanup } = teamProject("aya-waiting-on-", { teamFile: TEAM, tabs });
  const store = new TeamStore(teamDir(teamHome, "game", "ux-review"));
  await store.assign("leader", "pane-l");
  await store.assign("implementer", "pane-i");
  await store.assign("tester", "pane-t");
  const typed = [];
  const deps = {
    teamHome,
    listProjects: async () => [project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    holdReason: async () => null,
    headCommit: async () => "c0",
  };
  return { deps, store, typed, cleanup };
}

async function viaServer(team, frame) {
  const dir = mkdtempSync(join(tmpdir(), "aya-waiting-on-sock-"));
  const socketPath = join(dir, "c.sock");
  const sent = [];
  const stop = startControlServerOn(socketPath, {
    getWindow: () => null,
    getWindows: () => [{ isDestroyed: () => false, webContents: { send: (_channel, update) => sent.push(update) } }],
    team,
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      let data = "";
      const c = net.createConnection(socketPath, () => c.write(`${JSON.stringify(frame)}\n`));
      c.setEncoding("utf8");
      c.on("data", (d) => {
        data += d;
        if (data.includes("\n")) c.end();
      });
      c.on("close", () => resolve(data ? JSON.parse(data.split("\n")[0]) : null));
      c.on("error", reject);
    });
    return { reply, sent };
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

const frame = (pane, on, text = "answer on the adapter test") => ({
  type: "status",
  level: "waiting",
  text,
  ...(on ? { on } : {}),
  terminalId: pane,
  caller: { terminalId: pane },
});

// [label, pane, --on, refused with (null: taken), what the windows are told]
const SERVER = [
  ["in a team, --on a teammate", "pane-i", "tester", null, { level: "waiting-on", on: "tester" }],
  ["in a team, --on the lead", "pane-i", "leader", null, { level: "waiting-on", on: "leader" }],
  ["in a team, plain waiting", "pane-i", null, null, { level: "waiting" }],
  ["in a team, --on its own role", "pane-i", "implementer", /implementer is your own role/, null],
  ["in a team, --on no such role", "pane-i", "reviewer", /team ux-review has no role reviewer; its roles: leader, tester/, null],
  ["not in a team, --on a name", "pane-solo", "tester", /--on is for a wait on a team role.*drop --on/, null],
  ["not in a team, plain waiting", "pane-solo", null, null, { level: "waiting" }],
];

for (const [label, pane, on, refused, windows] of SERVER) {
  test(`control server | ${label}`, async () => {
    const w = await teamWorld();
    try {
      recordAgentStatus(pane, "clear", 0);
      const { reply, sent } = await viaServer(w.deps, frame(pane, on));
      if (refused) {
        assert.equal(reply.ok, false);
        assert.match(reply.error, refused);
        assert.deepEqual(sent, [], "the windows hear nothing");
        assert.equal(teammateWaits()[pane], undefined);
        assert.equal(agentWaitingSince(pane), null);
        return;
      }
      assert.equal(reply.ok, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].level, windows.level);
      assert.equal(sent[0].on, windows.on);
      assert.equal(agentWaitingSince(pane) !== null, windows.level === "waiting", "a question to the user");
    } finally {
      w.cleanup();
    }
  });
}

// ---- A teammate's message ends the wait, another's does not --------------------------------------------------------

for (const [from, fromPane, ends] of [["tester", "pane-t", true], ["leader", "pane-l", false]]) {
  test(`team send | implementer waits on tester, ${from}'s message is typed: the wait ${ends ? "ends" : "stays"}`, async () => {
    const w = await teamWorld();
    try {
      recordAgentStatus("pane-i", "waiting", 1000, "answer on the adapter test", undefined, undefined, "tester");
      const pushed = [];
      onStatusPushed((u) => pushed.push(u));
      await handleTeamRequest({ type: "team-send", role: "implementer", text: "the adapter test passes now" }, fromPane, w.deps);
      assert.equal(w.typed.filter((t) => t.pane === "pane-i").length, 1, "typed into the implementer's pane");
      assert.equal(teammateWaits()["pane-i"]?.on ?? null, ends ? null : "tester");
      assert.deepEqual(pushed.map((u) => [u.terminalId, u.level]), ends ? [["pane-i", "clear"]] : []);
    } finally {
      w.cleanup();
    }
  });
}

// ---- The role note and whoami tell team agents the teammate form --------------------------------------------------

test("role note | a team pane is told to wait on a teammate with --on, plain waiting asks the user", async () => {
  const { teamNote } = await import("../dist-electron/agent-brief.js");
  const note = teamNote("ux-review", "tester");
  assert.match(note, /aya status waiting --on <role> "what you need"/);
  assert.match(note, /Plain `aya status waiting` asks the user/);
});

test("whoami | names the teammate form", async () => {
  const w = await teamWorld();
  try {
    const { output } = await handleTeamRequest({ type: "team-whoami" }, "pane-i", w.deps);
    assert.match(output, /wait on a teammate with: aya status waiting --on <role> "what you need" \(plain aya status waiting asks the user\)/);
  } finally {
    w.cleanup();
  }
});

// ---- What the windows show -----------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-04T12:30:00Z");
const SINCE = Date.parse("2026-10-04T12:03:00Z");
const terminal = (over = {}) => ({
  id: "pane-i",
  name: "implementer",
  projectSlug: "game",
  presetId: "claude",
  status: "running",
  bell: false,
  exitCode: null,
  ...over,
});
const project = { slug: "game", name: "game", directory: "/game", tabs: [{ id: "pane-i" }, { id: "pane-l" }] };
const REPORTS = {
  "question (waiting)": (t) => applyReportedStatus(t, { level: "waiting", text: "need the staging password", updatedAt: SINCE }),
  "waiting on tester": (t) => applyReportedStatus(t, { level: "waiting-on", text: "answer on the adapter test", updatedAt: SINCE, on: "tester" }),
  done: (t) => applyReportedStatus(t, { level: "done", text: "Build passed", updatedAt: SINCE }),
  clear: (t) => clearedTerminalStatus(applyReportedStatus(t, { level: "waiting", text: "x", updatedAt: SINCE })),
};
const teamSummary = (assignments) => ({ assignments, paneHolds: {}, running: true, definition: { lead: "leader" } });

// [status, in a team, dot (status), bell (notification, sound, dock), attention count, team row, lead line]
const SHOWN = [
  ["question (waiting)", true, "waiting", true, true, "waiting for you since {t}", "leader is waiting for you since {t}: need the staging password"],
  ["question (waiting)", false, "waiting", true, true, null, null],
  ["waiting on tester", true, "idle", false, false, "waiting on tester since {t}", null],
  ["waiting on tester", false, "idle", false, false, null, null],
  ["done", true, "idle", false, true, "ready", null],
  ["done", false, "idle", false, true, null, null],
  ["clear", true, "idle", false, false, "ready", null],
  ["clear", false, "idle", false, false, null, null],
];

// The window's clock is local time.
const at = (text) => text?.replace("{t}", clockOf(SINCE)) ?? null;

for (const [report, inTeam, dot, bell, counted, row, leadLine] of SHOWN) {
  test(`shown | ${report}, ${inTeam ? "in a team" : "no team"}`, () => {
    const t = REPORTS[report](terminal());
    assert.equal(t.status, dot, "the dot");
    assert.equal(t.bell, bell, "the bell: notification, sound and dock badge");
    const badge = projectBadgeLevel(t);
    assert.equal(badge !== null && badge !== "active", counted, "counted in the attention count");
    const attention = attentionFor(project, t);
    assert.equal(attention !== null && isActionableLevel(attention.level), bell, "an actionable attention item");
    if (report === "waiting on tester") assert.equal(attention.title, "implementer is waiting on tester");
    const waiting = waitingPanesOf({ "pane-i": t });
    if (!inTeam) return;
    // The same pane as a plain role and as the lead.
    const asRole = roleStatus(teamSummary({ implementer: "pane-i" }), "implementer", project.tabs, waiting);
    assert.equal(asRole.text, at(row), "the role's row");
    assert.equal(asRole.tone === "held", bell, "the row is held only for the user");
    const lead = leadWaitingLine(teamSummary({ leader: "pane-i" }), waiting);
    assert.equal(lead?.text ?? null, at(leadLine), "the team's lead line");
  });
}

function clockOf(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- The lead's round digest -------------------------------------------------------------------------------------

const digestOf = (statusWaits) =>
  digestOneLine(
    roundDigest({
      roles: ["leader", "implementer", "tester"],
      lead: "leader",
      log: [{ id: 1, time: new Date(NOW - 60 * 60_000).toISOString(), from: "user", to: "leader", text: "task", commit: "c0", delivered: true }],
      progress: null,
      refused: [],
      turns: [],
      busy: [],
      statusWaits,
      nowMs: NOW,
    }),
  );

// [status, digest says, the role is idle]
const DIGEST = [
  ["question (waiting)", /Needs action: implementer asked the user 27 min ago: "need the staging password" \(only the user\)\./, false],
  ["waiting on tester", /Said they wait on a teammate: implementer on tester for 27 min: "answer on the adapter test"\./, false],
  ["none", null, true],
];
for (const [report, says, idle] of DIGEST) {
  test(`digest | implementer ${report}`, () => {
    const waits =
      report === "question (waiting)"
        ? [{ role: "implementer", on: null, text: "need the staging password", since: SINCE }]
        : report === "waiting on tester"
          ? [{ role: "implementer", on: "tester", text: "answer on the adapter test", since: SINCE }]
          : [];
    const line = digestOf(waits);
    if (says) assert.match(line, says);
    assert.doesNotMatch(report === "waiting on tester" ? line : "", /only the user|Needs action/, "a wait on a teammate is no block");
    assert.equal(/Idle over \d+ min: [^.]*implementer/.test(line), idle, "idle");
  });
}
