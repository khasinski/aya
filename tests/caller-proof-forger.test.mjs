// Accepted limit (docs/teams.md): the process-tree proof catches accidents, not a forger. These cells pin
// what it lets through, so a change that starts refusing them is a decision, not a side effect.

import { test } from "node:test";
import assert from "node:assert/strict";

const { unprovenIdentity } = await import("../dist-electron/caller-proof.js");

// pane-a: 100 > 150 (its shell) > 160 (aya). Another pane's process: 200 > 250 (the forger's aya).
const TABLE = new Map([
  [1, { ppid: 0, command: "launchd" }],
  [100, { ppid: 1, command: "zsh" }],
  [150, { ppid: 100, command: "zsh" }],
  [160, { ppid: 150, command: "node aya status" }],
  [200, { ppid: 1, command: "zsh" }],
  [250, { ppid: 200, command: "node aya team send" }],
]);

const CELLS = [
  ["honest caller under its pane", { terminalId: "pane-a", pid: 160 }, null],
  ["accident: another pane's process with pane-a's id is refused", { terminalId: "pane-a", pid: 250 }, "refused"],
  ["forger sends the pid of a process under pane-a: trusted", { terminalId: "pane-a", pid: 150 }, null],
  ["forger sends no pid: not refused", { terminalId: "pane-a" }, null],
  ["forger sends a pid nobody runs: not refused", { terminalId: "pane-a", pid: 99999 }, null],
];
// A recycled pid is the "pid of a process under pane-a" cell: no start time is compared. Remote tabs: caller-proof.test.mjs.

for (const [label, caller, expected] of CELLS) {
  test(`R-D1 forger cell | ${label}`, () => {
    const refusal = unprovenIdentity(caller, 100, TABLE);
    if (expected === null) assert.equal(refusal, null);
    else assert.match(refusal ?? "", /cannot be proven to come from this pane/);
  });
}
