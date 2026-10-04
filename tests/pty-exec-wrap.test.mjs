// A pane's command is wrapped in `exec` so the agent replaces the login shell. `exec -a` and `builtin` are not
// POSIX (dash has neither): those cases run only in a shell a probe shows supports the form.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellArgv } from "../dist-electron/pty.js";
import { distinctShells } from "./helpers/cli-shells.mjs";

const bin = mkdtempSync(path.join(tmpdir(), "exec-wrap-"));
writeFileSync(path.join(bin, "stubagent"), '#!/bin/sh\necho "pid=$$"\necho "ran:$X:$*"\n');
chmodSync(path.join(bin, "stubagent"), 0o755);

const BASHISM = [/^(X=1 )?exec -a /, /^builtin /, /^time /];
const SHELLS = distinctShells(["/bin/sh", "/bin/bash", "/bin/dash", "/bin/zsh"]);
const spawnFailures = [];
// Nonzero from the shell means it lacks the form; a spawn error is not that and fails the suite.
const supports = (shell, command) => {
  const r = spawnSync(shell, ["-c", command.replace(/stubagent a$/, "true").replace(/^builtin echo hi$/, "builtin true")], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    stdio: "ignore",
  });
  if (r.error || r.status === null) spawnFailures.push(`${shell}: ${r.error ?? "killed"}`);
  return r.status === 0;
};

// [command, last output line, whether the agent must replace the shell (same pid)]
const CASES = [
  ["stubagent a", "ran::a", true],
  ["exec stubagent a", "ran::a", true],
  ["X=1 stubagent a", "ran:1:a", true],
  ["X=1 exec stubagent a", "ran:1:a", true],
  ["exec  stubagent a", "ran::a", true],
  ["\\exec stubagent a", "ran::a", true],
  ["'exec' stubagent a", "ran::a", true],
  ["exec -a renamed stubagent a", "ran::a", true],
  ["X=1 exec -a renamed stubagent a", "ran:1:a", true],
  ["time exec stubagent a", "ran::a", false],
  ["cd /tmp && stubagent a", "ran::a", false],
  ["command stubagent a", "ran::a", true],
  ["X=1 command stubagent a", "ran:1:a", true],
  ["command  stubagent a", "ran::a", true],
  ["builtin echo hi", "hi", false],
];

const skipped = (shell, command) =>
  BASHISM.some((re) => re.test(command)) && !supports(shell, command) && "this shell does not have the form";
const skips = new Map(SHELLS.map((shell) => [shell, CASES.map(([command]) => skipped(shell, command))]));

test("the capability probe could spawn every shell, and one shell ran every case", () => {
  assert.deepEqual(spawnFailures, []);
  assert.ok([...skips.values()].some((list) => list.every((skip) => !skip)), "every shell skipped some case");
});

for (const shell of SHELLS) {
  CASES.forEach(([command, expected, replaces], i) => {
    const skip = skips.get(shell)[i];
    test(`${path.basename(shell)} runs ${JSON.stringify(command)} as a pane command`, { skip }, () => {
      const before = process.env.SHELL;
      process.env.SHELL = shell;
      let argv;
      try {
        argv = shellArgv(command, bin);
      } finally {
        if (before === undefined) delete process.env.SHELL;
        else process.env.SHELL = before;
      }
      const home = mkdtempSync(path.join(tmpdir(), "exec-wrap-home-"));
      const run = spawnSync(argv[0], argv.slice(1), {
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      const lines = run.stdout.toString().trim().split("\n");
      assert.equal(lines.pop(), expected, `${argv[4]} -> ${run.stderr}`);
      assert.equal(run.status, 0, run.stderr.toString());
      if (replaces) assert.equal(lines.pop(), `pid=${run.pid}`, "the agent must replace the login shell, not run under it");
    });
  });
}

test("the wrap text: exec is added once, to the program only, and not before builtins", () => {
  const before = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  try {
    const wrapped = (command) => shellArgv(command, "/w")[4].replace("cd '/w' && ", "");
    assert.equal(wrapped("claude"), "exec claude");
    assert.equal(wrapped("exec claude"), "exec claude");
    assert.equal(wrapped("exec"), "exec");
    assert.equal(wrapped("X=1 exec claude"), "X=1 exec claude");
    assert.equal(wrapped("X=1 claude"), "X=1 exec claude");
    assert.equal(wrapped("execute-it x"), "exec execute-it x", "a program that merely starts with exec is a program");
    assert.equal(wrapped("run-exec x"), "exec run-exec x");
    assert.equal(wrapped("command claude"), "exec claude", "command only skips functions, so exec the program");
    assert.equal(wrapped("X=1 command claude"), "X=1 exec claude");
    assert.equal(wrapped("command -v claude"), "command -v claude");
    assert.equal(wrapped("command"), "command");
    for (const already of ["\\exec claude", "'exec' claude", "time exec claude", "nohup exec claude", "env X=1 exec claude", "nice exec claude"]) {
      assert.equal(wrapped(already), already, `${already} already runs exec`);
    }
    assert.equal(wrapped("time claude"), "exec time claude");
    assert.equal(wrapped("builtin echo hi"), "builtin echo hi");
  } finally {
    if (before === undefined) delete process.env.SHELL;
    else process.env.SHELL = before;
  }
});
