// registerTeamIpc: the teams:* channels main registers, their argument checks,
// and the quit teardown of the redelivery timer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { registerTeamIpc, TEAM_REDELIVERY_MS } = await import("../dist-electron/team-ipc.js");
const { ROLE_DRAFT_CHAT } = await import("../dist-electron/team-draft.js");

function register({ listProjects = async () => [], teamHome = "/nonexistent-aya-home", holdReason = async () => null } = {}) {
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

test("registers the teams:* channels in order and one quit teardown", () => {
  const t = register();
  try {
    assert.deepEqual(
      [...t.handlers.keys()],
      [
        "teams:start",
        "teams:pause",
        "teams:resume",
        "teams:list",
        "teams:save",
        "teams:release-pane",
        "teams:assign",
        "teams:draft-role",
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
      cadence: null,
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
    cadence: null,
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
      cadence: null,
      protocol: "",
    });
    assert.deepEqual(refreshed, [["game", "ux-review"]]);
  } finally {
    t.teardowns.forEach((fn) => fn());
    rmSync(root, { recursive: true, force: true });
  }
});
