// Codex's shared daemon runs every later pane's commands with the first pane's env, so a call under a Codex
// app-server cannot name its project; an id set by hand in no pane's process (a script, e2e) still does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rpc } from "./helpers/control-rpc.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { startControlServerOn } = await import("../dist-electron/control.js");
const { agentWaitingSince, __resetAgentStatusForTests } = await import("../dist-electron/agent-status.js");

// pane-a (A): 100 > 150 > 160; its Codex TUI 300 forks daemon 320, whose commands sit under it: 330 > 340. pane-b (B):
// 200 > 250 > 260. Detached daemon: 900 (parent 1) > 910. 170: pane-a's aya whose argv mentions `codex app-server`.
const COMMANDS = { 170: "node /x/bin/aya team save codex app-server notes", 300: "node /usr/local/bin/codex", 320: "/opt/codex/bin/codex app-server --listen unix://", 900: "codex app-server" };
const PARENTS = new Map(
  [[1, 0], [100, 1], [150, 100], [160, 150], [170, 150], [200, 1], [250, 200], [260, 250], [300, 100], [320, 300], [330, 320], [340, 330], [900, 1], [910, 900]].map(
    ([pid, ppid]) => [pid, { ppid, command: COMMANDS[pid] ?? "sh" }],
  ),
);
const PANE_PIDS = { "pane-a": 100, "pane-b": 200 };
const PROJECTS = [
  { slug: "a", name: "a", directory: "/proj-a", tabs: [{ id: "pane-a", presetId: "codex", name: "a" }] },
  { slug: "b", name: "b", directory: "/proj-b", tabs: [{ id: "pane-b", presetId: "codex", name: "b" }] },
];
const UNPROVEN = /cannot be proven/;

const REQUESTS = [
  { type: "team-save", text: "# Team: t\n## Roles\n- implementer: builds\n## Lead\nimplementer\n" },
  { type: "team-start", team: "t" },
  { type: "team-open", team: "t", panes: [] },
  { type: "status", level: "waiting", text: "Which DB for project B?" },
];

// [label, caller, refused]
const CELLS = [
  ["a Codex in project B through the daemon pane-a's TUI started (pane-a's id)", { terminalId: "pane-a", pid: 340, cwd: "/proj-b" }, true],
  ["a command of a detached Codex daemon (pane-a's id)", { terminalId: "pane-a", pid: 910, cwd: "/proj-b" }, true],
  ["pane-a's id set by hand in pane-b's shell", { terminalId: "pane-a", pid: 260, cwd: "/proj-b" }, (type) => type === "team-save" || type === "team-start"],
  ["pane-a's own process", { terminalId: "pane-a", pid: 160, cwd: "/proj-a" }, false],
  ["pane-a's own aya whose argv mentions codex app-server (only ancestors count)", { terminalId: "pane-a", pid: 170, cwd: "/proj-a" }, false],
  ["pane-b's own process", { terminalId: "pane-b", pid: 260, cwd: "/proj-b" }, false],
  ["outside Aya (no pane id)", { pid: 910, cwd: "/proj-b" }, false],
  ["an older CLI that sends no pid", { terminalId: "pane-a", cwd: "/proj-b" }, false],
];

for (const request of REQUESTS) {
  for (const [label, caller, refused] of CELLS) {
    const refusedHere = typeof refused === "function" ? refused(request.type) : refused;
    test(`${request.type} acts on the caller's project only with proof | ${label} -> ${refusedHere ? "refused" : "not refused"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "aya-proof-proj-"));
      process.env.AYA_HOME = dir;
      __resetAgentStatusForTests();
      const socket = join(dir, "aya.sock");
      const stop = startControlServerOn(socket, {
        getWindow: () => null,
        openProject: () => {},
        listProjects: async () => PROJECTS,
        panePid: async (id) => PANE_PIDS[id] ?? null,
        processTable: async () => PARENTS,
      });
      try {
        const reply = await rpc(socket, { ...request, terminalId: caller.terminalId, caller });
        if (refusedHere) assert.match(reply.error ?? "", UNPROVEN);
        else assert.doesNotMatch(reply.error ?? "", UNPROVEN);
        if (request.type === "status" && caller.terminalId) assert.equal(agentWaitingSince(caller.terminalId) !== null, !refusedHere, "the question is the named pane's only when not refused");
      } finally {
        stop();
        __resetAgentStatusForTests();
        delete process.env.AYA_HOME;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
