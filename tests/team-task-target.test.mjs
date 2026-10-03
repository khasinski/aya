// The Task field of the Teams window says, before Start, who gets the task; a select picks another role.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as view from "../dist-test/team-view.js";

const taskPlaceholder = (...args) => view.taskPlaceholder(...args);

const { parseTeamFile } = await import("../dist-electron/team-definition.js");
const { taskRecipient } = await import("../dist-electron/team-runner.js");
const { registerTeamIpc } = await import("../dist-electron/team-ipc.js");

const BODY = `# ux-review

## Role: reviewer
Sends to: implementer (findings)
Must not: edit code

## Role: implementer
Sends to: reviewer (the commit)
Must not: skip a finding
`;
const WITH_LEAD = `${BODY}\n## Lead\nimplementer\n`;
const PACED = `${BODY}\n## Cadence\nreviewer every 30 min\n`;
const LEAD_AND_PACE = `${WITH_LEAD}\n## Cadence\nreviewer every 30 min\n`;

const SHAPES = {
  "lead and cadence on different roles (an old file: the rhythm's role leads)": LEAD_AND_PACE,
  "lead only": WITH_LEAD,
  "cadence only": PACED,
  "neither": BODY,
};
const PICKS = [undefined, "reviewer", "implementer"];

const EXPECTED = {
  "lead and cadence on different roles (an old file: the rhythm's role leads)": ["Task for reviewer (the lead)", "Task for reviewer", "Task for implementer"],
  "lead only": ["Task for implementer (the lead)", "Task for reviewer", "Task for implementer"],
  "cadence only": ["Task for reviewer (the lead)", "Task for reviewer", "Task for implementer"],
  neither: ["Task for reviewer (the first role)", "Task for reviewer", "Task for implementer"],
};

for (const [shape, file] of Object.entries(SHAPES)) {
  PICKS.forEach((pick, i) => {
    test(`task placeholder | ${shape}, pick ${pick ?? "none"}`, () => {
      const definition = parseTeamFile("ux-review", file);
      assert.equal(taskPlaceholder(definition, pick), EXPECTED[shape][i]);
      assert.ok(taskPlaceholder(definition, pick).startsWith(`Task for ${taskRecipient(definition, pick)}`));
    });
  });
}

test("task placeholder | a pick the team does not have falls back to the default recipient", () => {
  assert.equal(taskPlaceholder(parseTeamFile("ux-review", WITH_LEAD), "qa"), "Task for implementer (the lead)");
});

test("task placeholder | no definition (a file that does not parse) says only Task", () => {
  assert.equal(taskPlaceholder(null, undefined), "Task (optional)");
});

function register() {
  const handlers = new Map();
  const teardowns = [];
  const runner = registerTeamIpc({
    ipcMain: { handle: (channel, listener) => void handlers.set(channel, listener) },
    onBeforeQuit: (fn) => void teardowns.push(fn),
    team: { teamHome: "/nonexistent-aya-home", listProjects: async () => [], deliver: async () => {}, headCommit: async () => null, holdReason: async () => null, launchNote: async () => null },
    paneHost: {
      listPresets: async () => [],
      presetInstalled: async () => true,
      roleLaunch: async () => ({ reach: "unknown", refused: null }),
      launchBlock: async () => null,
      launchNote: async () => null,
      paneAlive: async () => true,
      openPanes: async () => {},
      newPaneId: () => "new-1",
    },
    intelligenceChat: () => async () => "{}",
  });
  return { runner, teardowns, invoke: async (channel, ...args) => handlers.get(channel)({}, ...args) };
}

test("teams:start | the picked role goes on as `to`; no pick, no `to`; a pick without a task is dropped", async () => {
  const t = register();
  try {
    const started = [];
    t.runner.start = async (...args) => void started.push(args);
    await t.invoke("teams:start", "game", "ux-review", "do it", "reviewer");
    await t.invoke("teams:start", "game", "ux-review", "do it");
    await t.invoke("teams:start", "game", "ux-review", "do it", "");
    await t.invoke("teams:start", "game", "ux-review", "", "reviewer");
    assert.deepEqual(started, [
      ["game", "ux-review", { text: "do it", to: "reviewer" }],
      ["game", "ux-review", { text: "do it" }],
      ["game", "ux-review", { text: "do it" }],
      ["game", "ux-review", undefined],
    ]);
    await assert.rejects(() => t.invoke("teams:start", "game", "ux-review", "do it", 5), { message: "Invalid IPC payload for teams:start.to: expected string." });
    assert.equal(started.length, 4);
  } finally {
    t.teardowns.forEach((fn) => fn());
  }
});
