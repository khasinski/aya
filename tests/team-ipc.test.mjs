// registerTeamIpc: the teams:* channels main registers, their argument checks,
// and the quit teardown of the redelivery timer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { registerTeamIpc, TEAM_REDELIVERY_MS } = await import("../dist-electron/team-ipc.js");
const { ROLE_DRAFT_CHAT } = await import("../dist-electron/team-draft.js");
const { TEAM_MESSAGE_MAX_CHARS } = await import("../dist-electron/control-protocol.js");

function register({
  listProjects = async () => [],
  teamHome = "/nonexistent-aya-home",
  holdReason = async () => null,
  openPanes = async () => {},
  launchNote = async () => null,
} = {}) {
  const handlers = new Map();
  const teardowns = [];
  const chats = [];
  const runner = registerTeamIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    onBeforeQuit: (fn) => void teardowns.push(fn),
    team: {
      teamHome,
      listProjects,
      deliver: async () => {},
      headCommit: async () => null,
      holdReason,
      launchNote,
    },
    paneHost: {
      listPresets: async () => [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }],
      presetInstalled: async () => true,
      roleLaunch: async () => ({ reach: "unknown", refused: null }),
      launchBlock: async () => null,
      launchNote: async () => null,
      paneAlive: async () => true,
      openPanes,
      newPaneId: () => "new-1",
    },
    intelligenceChat: (config, opts) => {
      chats.push({ config, opts });
      return async () => '{"mustNot": "edit code"}';
    },
  });
  const invoke = async (channel, ...args) => handlers.get(channel)({}, ...args);
  return { handlers, teardowns, chats, runner, invoke };
}

test("TEAM_REDELIVERY_MS is 15 s", () => {
  assert.equal(TEAM_REDELIVERY_MS, 15_000);
});

test("AYA_E2E_TEAM_REDELIVERY_MS sets the retry period, unset it is TEAM_REDELIVERY_MS", () => {
  const periods = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => (periods.push(ms), realSetInterval(fn, 1e9));
  const saved = process.env.AYA_E2E_TEAM_REDELIVERY_MS;
  const teardowns = [];
  try {
    delete process.env.AYA_E2E_TEAM_REDELIVERY_MS;
    teardowns.push(register());
    process.env.AYA_E2E_TEAM_REDELIVERY_MS = "3000";
    teardowns.push(register());
  } finally {
    globalThis.setInterval = realSetInterval;
    if (saved === undefined) delete process.env.AYA_E2E_TEAM_REDELIVERY_MS;
    else process.env.AYA_E2E_TEAM_REDELIVERY_MS = saved;
    for (const t of teardowns) for (const fn of t.teardowns) fn();
  }
  assert.deepEqual(periods.slice(0, 2), [TEAM_REDELIVERY_MS, 3000]);
});

test("registers the teams:* channels in order and one quit teardown", () => {
  const t = register();
  try {
    assert.deepEqual(
      [...t.handlers.keys()],
      [
        "teams:start",
        "teams:pause",
        "teams:resume",
        "teams:remove",
        "teams:list",
        "teams:save",
        "teams:release-pane",
        "teams:assign",
        "teams:draft-role",
        "teams:presets",
        "teams:open-panes",
      ],
    );
    assert.equal(t.teardowns.length, 1);
    assert.equal(typeof t.runner.redeliverWaiting, "function");
  } finally {
    t.teardowns.forEach((fn) => fn());
  }
});

test("channel arguments are validated with the channel's name", async () => {
  const t = register();
  try {
    await assert.rejects(() => t.invoke("teams:start", 5, "x"), {
      message: "Invalid IPC payload for teams:start.projectSlug: expected string.",
    });
    await assert.rejects(() => t.invoke("teams:resume", "game", null), {
      message: "Invalid IPC payload for teams:resume.team: expected string.",
    });
    await assert.rejects(() => t.invoke("teams:list", "game"), { message: "project game is not open" });
  } finally {
    t.teardowns.forEach((fn) => fn());
  }
});

test("teams:draft-role asks the configured chat with the role-draft options", async () => {
  const t = register();
  try {
    const team = {
      name: "ux-review",
      roles: [
        { id: "tester", sendsTo: [], mustNot: "", responsibilities: "" },
        { id: "implementer", sendsTo: [], mustNot: "", responsibilities: "" },
      ],
      lead: "tester",
      cadenceMinutes: null,
      protocol: "",
    };
    const draft = await t.invoke("teams:draft-role", team, "tester", { provider: "apple" });
    assert.equal(draft.mustNot, "edit code");
    assert.deepEqual(t.chats, [
      { config: { provider: "apple" }, opts: ROLE_DRAFT_CHAT },
    ]);
  } finally {
    t.teardowns.forEach((fn) => fn());
  }
});

test("teams:save edits an existing team unless asked to create; teams:assign reports an introduction it could not type", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-team-ipc-"));
  const directory = join(root, "game");
  mkdirSync(directory);
  const project = { slug: "game", name: "game", directory, tabs: [{ id: "pane-t" }, { id: "pane-i" }, { id: "pane-x" }] };
  const t = register({
    listProjects: async () => [project],
    teamHome: join(root, "aya"),
    holdReason: async (pane) => (pane === "pane-x" ? "shows an approval prompt" : null),
  });
  const team = {
    name: "ux-review",
    roles: [
      { id: "tester", sendsTo: [], mustNot: "edit code", responsibilities: "" },
      { id: "implementer", sendsTo: [], mustNot: "skip a report", responsibilities: "" },
    ],
    lead: "tester",
    cadenceMinutes: null,
    protocol: "",
  };
  try {
    await t.invoke("teams:save", "game", team, true);
    await assert.rejects(() => t.invoke("teams:save", "game", team, true), /already exists/);
    await t.invoke("teams:save", "game", team);
    assert.equal(await t.invoke("teams:assign", "game", "ux-review", "tester", "pane-t"), null);
    assert.equal(await t.invoke("teams:assign", "game", "ux-review", "implementer", "pane-i"), null);
    assert.equal((await t.invoke("teams:start", "game", "ux-review")).started, true);
    assert.equal(await t.invoke("teams:assign", "game", "ux-review", "tester", "pane-x"), "shows an approval prompt");
  } finally {
    t.teardowns.forEach((fn) => fn());
    rmSync(root, { recursive: true, force: true });
  }
});

test("teams:save hands the saved team to the runner, so running rounds follow it", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-team-ipc-"));
  const directory = join(root, "game");
  mkdirSync(directory);
  const project = { slug: "game", name: "game", directory, tabs: [] };
  const t = register({ listProjects: async () => [project], teamHome: join(root, "aya") });
  const refreshed = [];
  t.runner.refresh = async (...args) => void refreshed.push(args);
  try {
    await t.invoke("teams:save", "game", {
      name: "ux-review",
      roles: [
        { id: "tester", sendsTo: [], mustNot: "edit code", responsibilities: "" },
        { id: "implementer", sendsTo: [], mustNot: "skip a report", responsibilities: "" },
      ],
      lead: "tester",
      cadenceMinutes: null,
      protocol: "",
    });
    assert.deepEqual(refreshed, [["game", "ux-review"]]);
  } finally {
    t.teardowns.forEach((fn) => fn());
    rmSync(root, { recursive: true, force: true });
  }
});

test("teams:open-panes validates its picks and opens through the shared path", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-team-ipc-"));
  const directory = join(root, "game");
  mkdirSync(directory);
  let project = { slug: "game", name: "game", directory, tabs: [] };
  const t = register({
    listProjects: async () => [project],
    teamHome: join(root, "aya"),
    openPanes: async (_slug, panes) => void (project = { ...project, tabs: panes.map((p) => ({ id: p.id, presetId: p.presetId, name: p.name })) }),
  });
  const team = {
    name: "ux-review",
    roles: [
      { id: "tester", sendsTo: [], mustNot: "edit code", responsibilities: "" },
      { id: "implementer", sendsTo: [], mustNot: "skip a report", responsibilities: "" },
    ],
    lead: "tester",
    cadenceMinutes: null,
    protocol: "",
  };
  try {
    await t.invoke("teams:save", "game", team, true);
    await assert.rejects(() => t.invoke("teams:open-panes", "game", "ux-review", "tester=shell"), {
      message: "Invalid IPC payload for teams:open-panes.panes: expected [{role, target}].",
    });
    await assert.rejects(() => t.invoke("teams:open-panes", "game", "ux-review", [{ role: "tester" }]), /teams:open-panes\.panes/);
    const opened = await t.invoke("teams:open-panes", "game", "ux-review", [{ role: "tester", target: "shell" }]);
    assert.deepEqual(opened, {
      panes: [{ role: "tester", paneId: "new-1", name: "Shell - tester", preset: "Shell", notReached: null, cantReach: null, note: null, unsure: false }],
      leftWithoutPane: [],
    });
    // The Teams window's pick is the user's own choice: it may take a pane another role plays.
    const moved = await t.invoke("teams:open-panes", "game", "ux-review", [{ role: "implementer", target: "new-1" }]);
    assert.deepEqual(moved.leftWithoutPane, ["tester"]);
    // "No pane" rides the same call, so a refused pick releases nothing.
    await assert.rejects(() => t.invoke("teams:open-panes", "game", "ux-review", [{ role: "qa", target: "shell" }], ["implementer"]), /no role "qa"/);
    await assert.rejects(() => t.invoke("teams:open-panes", "game", "ux-review", [], "implementer"), /teams:open-panes\.release/);
    await assert.rejects(() => t.invoke("teams:open-panes", "game", "ux-review", [], [5]), /teams:open-panes\.release\[0\]/);
    const released = await t.invoke("teams:open-panes", "game", "ux-review", [], ["implementer"]);
    assert.deepEqual(released, { panes: [], leftWithoutPane: [] });
    assert.deepEqual((await t.invoke("teams:list", "game"))[0].assignments, {});
    assert.deepEqual(await t.invoke("teams:presets"), [{ id: "shell", name: "Shell", agent: "custom", installed: true, reach: "unknown", cantReach: null }]);
  } finally {
    t.teardowns.forEach((fn) => fn());
    rmSync(root, { recursive: true, force: true });
  }
});

test("teams:list carries what Aya widened for each assigned live pane, from the team's launchNote", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-team-ipc-"));
  const directory = join(root, "game");
  mkdirSync(directory);
  const project = { slug: "game", name: "game", directory, tabs: [{ id: "pane-t" }, { id: "pane-i" }] };
  const t = register({
    listProjects: async () => [project],
    teamHome: join(root, "aya"),
    launchNote: async (pane) => (pane === "pane-t" ? "widened" : null),
  });
  const team = {
    name: "ux-review",
    roles: [
      { id: "tester", sendsTo: [], mustNot: "edit code", responsibilities: "" },
      { id: "implementer", sendsTo: [], mustNot: "skip a report", responsibilities: "" },
    ],
    lead: "tester",
    cadenceMinutes: null,
    protocol: "",
  };
  try {
    await t.invoke("teams:save", "game", team, true);
    await t.invoke("teams:assign", "game", "ux-review", "tester", "pane-t");
    await t.invoke("teams:assign", "game", "ux-review", "implementer", "pane-i");
    assert.deepEqual((await t.invoke("teams:list", "game"))[0].paneNotes, { tester: "widened", implementer: null });
  } finally {
    t.teardowns.forEach((fn) => fn());
    rmSync(root, { recursive: true, force: true });
  }
});

test("teams:assign of two teams onto one pane at once leaves the pane with one team", async () => {
  const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");
  const root = mkdtempSync(join(tmpdir(), "aya-team-ipc-"));
  const directory = join(root, "game");
  mkdirSync(directory);
  const project = { slug: "game", name: "game", directory, tabs: [{ id: "pane-t" }] };
  const teamHome = join(root, "aya");
  const t = register({ listProjects: async () => [project], teamHome });
  const definition = (name) => ({
    name,
    roles: [
      { id: "tester", sendsTo: [], mustNot: "edit code", responsibilities: "" },
      { id: "implementer", sendsTo: [], mustNot: "skip a report", responsibilities: "" },
    ],
    lead: "tester",
    cadenceMinutes: null,
    protocol: "",
  });
  try {
    await t.invoke("teams:save", "game", definition("alpha"), true);
    await t.invoke("teams:save", "game", definition("beta"), true);
    const holders = async () =>
      (await Promise.all(["alpha", "beta"].map((name) => new TeamStore(teamDir(teamHome, "game", name)).assignments()))).filter(
        (a) => a.tester === "pane-t",
      ).length;
    for (let i = 0; i < 30; i++) {
      await Promise.all([t.invoke("teams:assign", "game", "alpha", "tester", "pane-t"), t.invoke("teams:assign", "game", "beta", "tester", "pane-t")]);
      assert.equal(await holders(), 1, `round ${i}: one team holds the pane`);
      await t.invoke("teams:release-pane", "game", "pane-t");
      assert.equal(await holders(), 0);
    }
  } finally {
    t.teardowns.forEach((fn) => fn());
    rmSync(root, { recursive: true, force: true });
  }
});

test("the quit teardown stops the rounds and the redelivery timer", () => {
  const t = register();
  let stopped = 0;
  t.runner.stopAll = () => void stopped++;
  t.teardowns.forEach((fn) => fn());
  assert.equal(stopped, 1);
});

test("registering restores the running teams once, and a failed restore is a warning, not a crash", async () => {
  const { TeamRunner } = await import("../dist-electron/team-runner.js");
  const original = TeamRunner.prototype.restore;
  const warned = [];
  const warn = console.warn;
  let restores = 0;
  TeamRunner.prototype.restore = async () => {
    restores++;
    throw new Error("disk gone");
  };
  console.warn = (...a) => warned.push(a.join(" "));
  let t;
  try {
    t = register();
    await new Promise((r) => setImmediate(r));
  } finally {
    TeamRunner.prototype.restore = original;
    console.warn = warn;
    t?.teardowns.forEach((fn) => fn());
  }
  assert.equal(restores, 1);
  assert.deepEqual(warned, ["[aya] team rounds not restored: Error: disk gone"]);
});

for (const action of ["pause", "resume", "remove"]) {
  test(`teams:${action} runs the runner's ${action} for that project and team, and no other action`, async () => {
    const t = register();
    try {
      const calls = [];
      for (const name of ["start", "pause", "resume", "remove"]) t.runner[name] = async (...args) => void calls.push([name, ...args]);
      await t.invoke(`teams:${action}`, "game", "ux-review");
      assert.deepEqual(calls, [[action, "game", "ux-review"]]);
    } finally {
      t.teardowns.forEach((fn) => fn());
    }
  });
}

test("teams:start checks the task: none, a string, or too long before anything starts", async () => {
  const t = register();
  try {
    const started = [];
    t.runner.start = async (...args) => void started.push(args);
    for (const none of [undefined, null, ""]) await t.invoke("teams:start", "game", "ux-review", none);
    await t.invoke("teams:start", "game", "ux-review", "do the thing");
    assert.deepEqual(started, [
      ["game", "ux-review", undefined],
      ["game", "ux-review", undefined],
      ["game", "ux-review", undefined],
      ["game", "ux-review", { text: "do the thing" }],
    ]);
    await assert.rejects(() => t.invoke("teams:start", "game", "ux-review", 5), { message: "Invalid IPC payload for teams:start.task: expected string." });
    await assert.rejects(() => t.invoke("teams:start", "game", "ux-review", "x".repeat(TEAM_MESSAGE_MAX_CHARS + 1)), new RegExp(`the task is ${TEAM_MESSAGE_MAX_CHARS + 1} characters, the most is ${TEAM_MESSAGE_MAX_CHARS};`));
    assert.equal(started.length, 4, "nothing started for a bad task");
  } finally {
    t.teardowns.forEach((fn) => fn());
  }
});

test("teams:start passes the picked role with the task, none for an empty pick, and refuses a non-string", async () => {
  const t = register();
  try {
    const started = [];
    t.runner.start = async (...args) => void started.push(args);
    await t.invoke("teams:start", "game", "ux-review", "do it", "implementer");
    await t.invoke("teams:start", "game", "ux-review", "do it", "");
    assert.deepEqual(started, [
      ["game", "ux-review", { text: "do it", to: "implementer" }],
      ["game", "ux-review", { text: "do it" }],
    ]);
    await assert.rejects(() => t.invoke("teams:start", "game", "ux-review", "do it", 5), { message: "Invalid IPC payload for teams:start.to: expected string." });
  } finally {
    t.teardowns.forEach((fn) => fn());
  }
});
