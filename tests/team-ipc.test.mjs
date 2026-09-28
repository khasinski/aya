// registerTeamIpc: the teams:* channels main registers, their argument checks,
// and the quit teardown of the redelivery timer.

import { test } from "node:test";
import assert from "node:assert/strict";

const { registerTeamIpc, TEAM_REDELIVERY_MS } = await import("../dist-electron/team-ipc.js");
const { ROLE_DRAFT_CHAT } = await import("../dist-electron/team-draft.js");

function register({ listProjects = async () => [] } = {}) {
  const handlers = new Map();
  const teardowns = [];
  const chats = [];
  const runner = registerTeamIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    onBeforeQuit: (fn) => void teardowns.push(fn),
    team: {
      teamHome: "/nonexistent-aya-home",
      listProjects,
      deliver: async () => {},
      headCommit: async () => null,
      holdReason: async () => null,
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
