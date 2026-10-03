// A command's directory says nothing about its identity: a user who cds from one project's pane into another is still
// that pane. Only the process proof decides, and only for role commands.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { rpc } from "./helpers/control-rpc.mjs";

const { startControlServerOn } = await import("../dist-electron/control.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-cwd-proven-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const dir = (...parts) => {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const A = dir("repo", "pkg");
const PARENT = dir("repo");
const B = dir("other");
const OUTSIDE = dir("elsewhere");
const tab = (id) => ({ id, presetId: "codex", name: id });
const PROJECTS = [
  { slug: "pkg", name: "pkg", directory: A, tabs: [tab("pane-a")] },
  { slug: "repo", name: "repo", directory: PARENT, tabs: [tab("pane-repo")] },
  { slug: "other", name: "other", directory: B, tabs: [tab("pane-b")] },
];

const PANE = 100;
const row = (ppid, command = "x") => ({ ppid, command });
const TABLE = new Map([
  [PANE, row(1, "zsh")],
  [101, row(PANE, "zsh")],
  [102, row(101, "aya team whoami")], // under the pane's shell
  [200, row(PANE, "codex app-server")],
  [201, row(200, "aya team whoami")], // under the shared daemon
  [300, row(1, "aya team whoami")], // a job left running
]);

const PROOFS = {
  "under the pane's shell": { pid: 102, proven: true },
  "under a codex app-server daemon": { pid: 201, proven: false },
  "a job outside the pane's process": { pid: 300, proven: false },
  "a pid the process table lacks": { pid: 999, proven: false },
  "no pid sent (older CLI)": { pid: undefined, proven: false },
};
const CWDS = {
  "its own directory": A,
  "the parent project's directory": PARENT,
  "another open project": B,
  "outside every project": OUTSIDE,
};
// team requests also need the pane's process proven, so a bad pid there is refused for that reason
const REQUESTS = {
  "team-whoami": { type: "team-whoami" },
  "pane-list": { type: "pane-list" },
  "pane-send": { type: "pane-send", target: "pane-b", text: "hi" },
};
const TEAM = new Set(["team-whoami"]);

const sockDir = mkdtempSync(join(tmpdir(), "aya-cwd-proven-s-"));
const socket = join(sockDir, "aya.sock");
const stop = startControlServerOn(socket, {
  getWindow: () => null,
  openProject: () => {},
  listProjects: async () => PROJECTS,
  readPane: async () => "",
  writePane: async () => true,
  panePid: async () => PANE,
  processTable: async () => TABLE,
  team: { teamHome: dir("team-home"), listProjects: async () => PROJECTS },
});
after(() => {
  stop();
  rmSync(sockDir, { recursive: true, force: true });
});

for (const [proofName, proof] of Object.entries(PROOFS)) {
  for (const [cwdName, cwd] of Object.entries(CWDS)) {
    for (const [requestName, request] of Object.entries(REQUESTS)) {
      test(`caller ${proofName} x cwd ${cwdName} x ${requestName}`, async () => {
        const caller = { terminalId: "pane-a", cwd, ...(proof.pid ? { pid: proof.pid } : {}) };
        const reply = await rpc(socket, { ...request, caller });
        const error = reply.error ?? "";
        assert.doesNotMatch(error, /another pane's identity/);
        // a team request whose pid does not descend from the pane is refused by the proof (when a pid was sent and listed)
        const proofApplies = TEAM.has(requestName) && proof.pid && TABLE.has(proof.pid) && !proof.proven;
        assert.equal(/cannot be proven/.test(error), Boolean(proofApplies), error);
      });
    }
  }
}
