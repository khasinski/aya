// `exec` goes only in front of a simple command: `exec cd sub && claude` replaces the shell with /usr/bin/cd.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { shellArgv } = await import("../dist-electron/pty.js");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "aya-exec-"));
  for (const d of ["bin", "sub", "home"]) mkdirSync(join(dir, d));
  writeFileSync(join(dir, "bin", "claude"), '#!/bin/sh\necho "$FOO $PWD" > "$SBX_OUT"\n');
  chmodSync(join(dir, "bin", "claude"), 0o755);
  return dir;
}

function launched(command) {
  const dir = sandbox();
  const argv = shellArgv(command, dir);
  spawnSync("/bin/sh", ["-c", argv[4]], {
    env: { ...process.env, HOME: join(dir, "home"), PATH: `${join(dir, "bin")}:${process.env.PATH}`, SBX_OUT: join(dir, "out") },
  });
  return existsSync(join(dir, "out")) ? { dir } : null;
}

const CASES = [
  ["claude", true, /exec claude$/],
  ["FOO=1 claude", true, /FOO=1 exec claude$/],
  ["/usr/bin/env claude", true, /exec \/usr\/bin\/env claude$/],
  ["cd sub && claude", true, /&& cd sub && claude$/],
  ["true && claude", true, /&& true && claude$/],
  ["(cd sub; claude)", true, /&& \(cd sub; claude\)$/],
  ["cd sub; claude", true, /&& cd sub; claude$/],
  ["export FOO=1 && claude", true, /&& export FOO=1 && claude$/],
  ["cd sub", false, /&& cd sub$/],
  ["FOO=1 cd sub", false, /&& FOO=1 cd sub$/],
];

for (const [command, starts, argvPattern] of CASES) {
  test(`preset "${command}" launches the CLI`, () => {
    const run = launched(command);
    assert.equal(run !== null, starts);
    assert.match(shellArgv(command, "/x")[4], argvPattern);
    if (run && /\bcd sub\b/.test(command)) assert.match(readOut(run.dir), /sub$/);
  });
}

// A brief or role note is one quoted argument that may hold any of these.
const QUOTED = ["a; b", "a && b", "a | b", "line1\nline2", "a `b` c", "a $(b) c", "it's; fine"];
for (const text of QUOTED) {
  for (const quote of [(t) => `'${t.replace(/'/g, "'\\''")}'`, (t) => `"${t.replace(/(["\\`$])/g, "\\$1")}"`]) {
    test(`a quoted argument ${JSON.stringify(text)} keeps exec`, () => {
      const command = `claude --append-system-prompt ${quote(text)}`;
      assert.match(shellArgv(command, "/x")[4], /exec claude --append-system-prompt/);
      assert.match(shellArgv(`FOO=1 ${command}`, "/x")[4], /FOO=1 exec claude/);
    });
  }
}

for (const command of ["claude 'a'; b", "claude 'a' && b", "claude 'a' | b", "claude 'a'\nb", "claude 'a' `b`"]) {
  test(`an unquoted operator after a quote still blocks exec: ${JSON.stringify(command)}`, () => {
    assert.doesNotMatch(shellArgv(command, "/x")[4], /exec claude/);
  });
}

function readOut(dir) {
  return readFileSync(join(dir, "out"), "utf8").trim();
}
