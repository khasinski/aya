// `aya team open <team> role=this` gives the role to the caller's pane only once that pane id is proven, because
// Codex's shared daemon runs every pane's commands with the id of the pane that started it. Table: caller x target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rpc } from "./helpers/control-rpc.mjs";
import { teamProject } from "./helpers/team.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { teamPaneDeps } = await import("../dist-electron/team-panes.js");
const { TeamRunner } = await import("../dist-electron/team-runner.js");
const { TeamStore, teamDir } = await import("../dist-electron/team-store.js");

// pane-a: 100 > 150 > 160 (aya). pane-b: 200 > 250 > 260. The daemon a started: 900 (parent 1) > 910.
const PARENTS = new Map(
  [[100, 1], [150, 100], [160, 150], [200, 1], [250, 200], [260, 250], [900, 1], [910, 900], [1, 0]].map(([pid, ppid]) => [
    pid,
    { ppid, command: pid === 900 ? "codex app-server --listen unix://" : "sh" },
  ]),
);
const PANE_PIDS = { "pane-a": 100, "pane-b": 200 };
const TEAM = `# ux-review

## Role: reviewer
Sends to: builder (findings)
Must not: edit code

## Role: builder
Sends to: reviewer (what changed)
Must not: skip a report
`;
const TABS = [{ id: "pane-a", presetId: "codex", name: "a" }, { id: "pane-b", presetId: "codex", name: "b" }];
const UNPROVEN = /cannot be proven/;
const NO_PANE = /nothing was opened/;

// [name, caller, role target, outcome]: a refusal by the proof, a role given to the pane (or "new"), or the command's own error
const CELLS = [
  ["A's own process, this", { terminalId: "pane-a", pid: 160 }, "this", "pane-a"],
  ["B's own process, this", { terminalId: "pane-b", pid: 260 }, "this", "pane-b"],
  ["a command the daemon A started runs, this", { terminalId: "pane-a", pid: 910 }, "this", UNPROVEN],
  ["A's id typed in B's process tree, this", { terminalId: "pane-a", pid: 260 }, "this", UNPROVEN],
  ["an older CLI sends no pid, this", { terminalId: "pane-a" }, "this", "pane-a"],
  ["no pane id (outside Aya), this", { pid: 910 }, "this", NO_PANE],
  // The id only finds the project for these targets, and a Codex daemon's id may be another project's.
  ["a command the daemon A started runs, pane:b", { terminalId: "pane-a", pid: 910 }, "pane:b", UNPROVEN],
  ["a command the daemon A started runs, new:codex", { terminalId: "pane-a", pid: 910 }, "new:codex", UNPROVEN],
  ["A's id typed in B's process tree, pane:a", { terminalId: "pane-a", pid: 260 }, "pane:a", "pane-a"],
];

async function withServer(body) {
  const dir = mkdtempSync(join(tmpdir(), "aya-proof-open-"));
  const socket = join(dir, "aya.sock");
  const world = teamProject("aya-proof-team-", { teamFile: TEAM, tabs: TABS });
  const store = new TeamStore(teamDir(world.teamHome, "game", "ux-review"));
  let project = world.project;
  const control = { teamHome: world.teamHome, listProjects: async () => [project], deliver: async () => {}, headCommit: async () => null, holdReason: async () => null };
  const opened = [];
  let next = 0;
  const host = {
    listPresets: async () => [{ id: "codex", name: "Codex", icon: "o", color: "", command: "codex" }],
    presetInstalled: async () => true,
    roleLaunch: async () => ({ reach: "reaches", refused: null }),
    launchBlock: async () => null,
    launchNote: async () => null,
    paneAlive: async (pane) => !pane.startsWith("gone"),
    openPanes: async (slug, panes) => {
      opened.push(...panes.map((p) => p.id));
      project = { ...project, tabs: [...project.tabs, ...panes.map((p) => ({ id: p.id, presetId: p.presetId, name: p.name }))] };
    },
    newPaneId: () => `new-${++next}`,
  };
  const stop = startControlServerOn(socket, {
    getWindow: () => null,
    openProject: () => {},
    listProjects: async () => [project],
    panePid: async (id) => PANE_PIDS[id] ?? null,
    processTable: async () => PARENTS,
    teamPanes: { ...teamPaneDeps(control, host, new TeamRunner(control)), startWaitMs: 1_000 },
  });
  const given = async () => {
    try {
      return JSON.parse(readFileSync(join(store.dir, "assignments.json"), "utf8"));
    } catch {
      return {};
    }
  };
  try {
    return await body(socket, { dir: world.directory, given, opened });
  } finally {
    stop();
    world.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, caller, target, outcome] of CELLS) {
  test(`team-open: ${name} -> ${outcome instanceof RegExp ? "refused" : "allowed"}`, async () => {
    await withServer(async (socket, { dir, given }) => {
      const reply = await rpc(socket, { type: "team-open", team: "ux-review", panes: [{ role: "reviewer", target }], caller: { ...caller, cwd: dir } });
      if (outcome instanceof RegExp) {
        assert.match(reply.error ?? "", outcome);
        assert.deepEqual(await given(), {}, "a refused pick gives no role away");
      } else {
        assert.equal(reply.error, undefined);
        assert.equal((await given()).reviewer, outcome, "the role went to the pane the pick named");
      }
    });
  });
}

test("team-open: one pick of this among others is enough to need the proof, in either order", async () => {
  await withServer(async (socket, { dir, given, opened }) => {
    for (const panes of [
      [{ role: "reviewer", target: "this" }, { role: "builder", target: "new:codex" }],
      [{ role: "builder", target: "new:codex" }, { role: "reviewer", target: "this" }],
    ]) {
      const reply = await rpc(socket, { type: "team-open", team: "ux-review", panes, caller: { terminalId: "pane-a", pid: 910, cwd: dir } });
      assert.match(reply.error ?? "", UNPROVEN);
      assert.deepEqual([await given(), opened], [{}, []], "the unproven pick opens nothing and gives nothing away");
    }
  });
});
