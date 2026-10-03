// Who paused a team decides who may resume it. A role's pane is proven by the pane id it carries and the pane
// whose process the command runs under.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rpc } from "./helpers/control-rpc.mjs";
import { teamProject } from "./helpers/team.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { teamPaneDeps } = await import("../dist-electron/team-panes.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

const TEAM = `# ux-review

## Role: leader
Sends to: implementer (the next step), benchmarker (what to measure)
Must not: edit code

## Role: implementer
Sends to: benchmarker (a solver to measure), leader (what changed)
Must not: skip the tests

## Role: benchmarker
Sends to: leader (node counts), implementer (node counts)
Must not: change the solver

## Lead
leader
`;

// pane-l 100 > 150 > 160; pane-i 200 > 260; pane-b 300 > 360; pane-s (a plain shell, no role) 400 > 460; a terminal outside Aya 960.
const PARENTS = new Map(
  [[100, 1], [150, 100], [160, 150], [200, 1], [260, 200], [300, 1], [360, 300], [400, 1], [460, 400], [960, 1], [1, 0]].map(([pid, ppid]) => [pid, { ppid, command: "sh" }]),
);
const PANE_PIDS = { "pane-l": 100, "pane-i": 200, "pane-b": 300, "pane-s": 400 };
const TABS = Object.keys(PANE_PIDS).map((id) => ({ id }));

const CALLERS = {
  window: null,
  "aya outside the panes": { pid: 960 },
  "a pane with no role": { terminalId: "pane-s", pid: 460 },
  "the lead's pane": { terminalId: "pane-l", pid: 160 },
  "the lead's pane, AYA_TERMINAL_ID unset": { pid: 160 },
  "another role's pane": { terminalId: "pane-i", pid: 260 },
  "another role's pane, AYA_TERMINAL_ID unset": { pid: 260 },
  "the lead's id typed in another role's pane": { terminalId: "pane-l", pid: 260 },
  "the lead's id typed in a pane with no role": { terminalId: "pane-l", pid: 460 },
};
const SPOOFED = new Set(["the lead's id typed in another role's pane", "the lead's id typed in a pane with no role"]);
const UNPROVEN = /cannot be proven to come from this pane/;
const USERS = new Set(["window", "aya outside the panes", "a pane with no role"]);
const LEAD = new Set(["the lead's pane", "the lead's pane, AYA_TERMINAL_ID unset"]);

async function world(pausedBy) {
  const t = teamProject("aya-pause-owner-", { teamFile: TEAM, tabs: TABS });
  const dir = mkdtempSync(join(tmpdir(), "aya-pause-owner-sock-"));
  const socket = join(dir, "aya.sock");
  const store = new TeamStore(teamDir(t.teamHome, "game", "ux-review"));
  await store.assign("leader", "pane-l");
  await store.assign("implementer", "pane-i");
  await store.assign("benchmarker", "pane-b");
  const typed = [];
  const control = {
    teamHome: t.teamHome,
    listProjects: async () => [t.project],
    deliver: async (pane, text) => void typed.push({ pane, text }),
    headCommit: async () => null,
    holdReason: async () => null,
  };
  const never = () => () => {};
  const runner = new TeamRunner(control, never, Date.now, () => {});
  const host = {
    listPresets: async () => [],
    presetInstalled: async () => true,
    roleLaunch: async () => ({ reach: "reaches", refused: null }),
    launchBlock: async () => null,
    launchNote: async () => null,
    paneAlive: async () => true,
    openPanes: async () => {},
    newPaneId: () => "new-1",
  };
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: control.listProjects,
    readPane: async () => "",
    writePane: async () => {},
    panePid: async (id) => PANE_PIDS[id] ?? null,
    processTable: async () => PARENTS,
    team: control,
    teamRunner: runner,
    teamPanes: teamPaneDeps(control, host, runner),
  });
  // As bin/aya sends it, team-start carries the cwd: it names the project outside a pane.
  const call = (caller, frame) => rpc(socket, { ...frame, ...(frame.type === "team-start" ? { cwd: t.directory } : {}), caller: { ...caller, cwd: t.directory } });
  if (pausedBy !== "never") await runner.start("game", "ux-review");
  if (pausedBy === "user") await runner.pause("game", "ux-review");
  if (pausedBy === "lead") {
    const reply = await call(CALLERS["the lead's pane"], { type: "team-pause", text: "no lower complexity is possible" });
    assert.equal(reply.error, undefined, "the lead paused it");
  }
  if (pausedBy === "legacy") {
    // A state.json from before Aya kept who paused: only the window paused then.
    writeFileSync(join(store.dir, "state.json"), JSON.stringify({ paused: true, started: true, lastRound: 12 }));
  }
  typed.length = 0;
  const start = (caller, task) =>
    caller === null
      ? runner.start("game", "ux-review", { text: task, to: "implementer" }).then((r) => (r.alreadyRunning ? { error: "team ux-review is already running" } : r.refused ? { error: r.refused } : {}))
      : call(caller, { type: "team-start", team: "ux-review", task, to: "implementer" });
  return {
    store,
    typed,
    runner,
    call,
    start,
    cleanup: () => {
      stop();
      runner.stopAll();
      t.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ownerTest = (name, ...args) => {
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

const RUNNING_ROLE = /the team is running; use aya team send/;
const USER_PAUSED = /the user paused this team; only the user can resume it/;
const LEAD_PAUSED = /the lead \(leader\) paused this team; only leader or the user can resume it/;

/** What `aya team start <team> <task> --to implementer` ends as. */
function expectedStart(pausedBy, caller) {
  if (SPOOFED.has(caller)) return UNPROVEN;
  if (pausedBy === "never") return { from: USERS.has(caller) ? "user" : CALLERS[caller] && LEAD.has(caller) ? "leader" : "implementer" };
  if (pausedBy === "running") return USERS.has(caller) ? /already running/ : RUNNING_ROLE;
  if (USERS.has(caller)) return { from: "user" };
  if (pausedBy === "lead" && LEAD.has(caller)) return { from: "leader" };
  return pausedBy === "lead" ? LEAD_PAUSED : USER_PAUSED;
}

for (const pausedBy of ["never", "running", "user", "lead", "legacy"]) {
  for (const caller of Object.keys(CALLERS)) {
    const want = expectedStart(pausedBy, caller);
    ownerTest(`aya team start | team ${pausedBy === "never" ? "never started" : pausedBy === "running" ? "running" : `paused by ${pausedBy}`} | from ${caller} -> ${want instanceof RegExp ? "refused" : `started, task from ${want.from}`}`, pausedBy === "running" ? "none" : pausedBy, async (w) => {
      const before = { state: await w.store.state(), pausedBy: await w.store.pausedBy(), log: (await w.store.log()).length };
      const reply = await w.start(CALLERS[caller], "1b27df1 is already measured: easy 51, medium 45, hard 393, total 489.");
      if (want instanceof RegExp) {
        assert.match(reply.error ?? "", want);
        assert.deepEqual(w.typed, [], "nothing typed into any pane");
        assert.deepEqual(
          { state: await w.store.state(), pausedBy: await w.store.pausedBy(), log: (await w.store.log()).length },
          before,
          "the team stays as it was, and nothing is logged",
        );
        return;
      }
      assert.equal(reply.error, undefined);
      assert.deepEqual(await w.store.state(), { paused: false, running: true });
      assert.equal(await w.store.pausedBy(), null, "a running team has no pauser");
      const task = (await w.store.log()).find((m) => m.to === "implementer" && /already measured/.test(m.text));
      assert.equal(task?.from, want.from, "the log names who really gave the task");
      assert.ok(w.typed.some((x) => x.pane === "pane-i" && x.text.includes(`from ${want.from}`)), "typed with the real sender");
    });
  }
}

test("Pause in the window records the user; aya team pause from the lead records the lead", async () => {
  const user = await world("user");
  const lead = await world("lead");
  try {
    assert.equal(await user.store.pausedBy(), "user");
    assert.equal(await lead.store.pausedBy(), "leader");
    assert.match((await lead.store.log()).at(-1).text, /^leader \(the lead\) paused the team: no lower complexity is possible$/);
  } finally {
    user.cleanup();
    lead.cleanup();
  }
});

ownerTest("the lead's aya team pause on a team the user paused does not take the pause over", "user", async (w) => {
  const reply = await w.call(CALLERS["the lead's pane"], { type: "team-pause", text: "mine now" });
  assert.match(reply.output ?? "", /already paused/);
  assert.equal(await w.store.pausedBy(), "user");
  assert.match((await w.start(CALLERS["the lead's pane"], "go on")).error ?? "", USER_PAUSED);
});

ownerTest("Pause in the window on a team the lead paused makes it the user's pause; the lead can no longer resume it", "lead", async (w) => {
  await w.runner.pause("game", "ux-review");
  assert.equal(await w.store.pausedBy(), "user");
  assert.match((await w.start(CALLERS["the lead's pane"], "go on")).error ?? "", USER_PAUSED);
});

ownerTest("a lead's pause landing on a team the user just paused leaves it the user's", "user", async (w) => {
  await w.runner.pause("game", "ux-review", "leader");
  assert.equal(await w.store.pausedBy(), "user");
});

for (const pausedBy of ["user", "lead", "legacy"]) {
  ownerTest(`Resume in the window works on a team paused by ${pausedBy}`, pausedBy, async (w) => {
    await w.runner.resume("game", "ux-review");
    assert.deepEqual(await w.store.state(), { paused: false, running: true });
    assert.equal(await w.store.pausedBy(), null);
  });
}

for (const pausedBy of ["user", "lead"]) {
  for (const caller of ["the lead's pane", "another role's pane"]) {
    ownerTest(`aya team send while paused by ${pausedBy}, from ${caller}: refused, nothing typed or logged`, pausedBy, async (w) => {
      const to = caller === "the lead's pane" ? "implementer" : "benchmarker";
      const before = (await w.store.log()).length;
      const reply = await w.call(CALLERS[caller], { type: "team-send", role: to, text: "measure 1b27df1 again" });
      assert.match(reply.error ?? "", /team ux-review is paused; nothing was sent/);
      assert.deepEqual(w.typed, []);
      assert.equal((await w.store.log()).length, before);
    });
  }
}

// A live log: the user paused, then the lead's pane ran three Starts, each with a task to the implementer.
ownerTest("replay of the sudoku log: three Starts from the lead's pane after the user's Pause are all refused", "user", async (w) => {
  const tasks = [
    "1b27df1 is already measured: easy 51, medium 45, hard 393, total 489.",
    "Stop waiting. 1b27df1 is already measured: easy 51, medium 45, hard 393, total 489.",
    "A second commit is the next cut. 1b27df1 is already measured at easy 51, medium 45, hard 393.",
  ];
  for (const task of tasks) assert.match((await w.start(CALLERS["the lead's pane"], task)).error ?? "", USER_PAUSED);
  assert.deepEqual(await w.store.state(), { paused: true, running: false });
  assert.deepEqual(w.typed, [], "no delivery test and no task reached any pane");
  assert.equal((await w.store.log()).filter((m) => m.from === "user").length, 0, "nothing logged as the user's");
});

test("the brief, the role note, whoami and aya capabilities: give work with aya team send, never aya team start", async () => {
  const { AYA_CAPABILITIES } = await import("../dist-electron/capabilities.js");
  const { teamNote, briefText } = await import("../dist-electron/agent-brief.js");
  const { handleTeamRequest } = await import("../dist-electron/team-control.js");
  const start = AYA_CAPABILITIES.find((c) => c.command === "team start");
  assert.ok(start.notes.some((n) => /^Never run it to give a teammate work: that is aya team send\./.test(n)));
  assert.ok(start.notes.some((n) => /refused while the team runs, and on a pause the user made/.test(n)));
  assert.match(teamNote("ux-review", "leader"), /Give a teammate work with `aya team send`, never `aya team start`/);
  assert.match(briefText(false), /never to give a role work \(that is `aya team send`\)/);
  const w = await world("none");
  try {
    for (const pane of ["pane-l", "pane-i"]) {
      const { output } = await handleTeamRequest({ type: "team-whoami" }, pane, { teamHome: w.store.dir.split("/teams/")[0], listProjects: async () => [{ slug: "game", name: "game", directory: "", tabs: TABS }], deliver: async () => {}, headCommit: async () => null, holdReason: async () => null });
      assert.match(output, /give a role work with: aya team send <role> "text" \(not aya team start/);
    }
  } finally {
    w.cleanup();
  }
});
