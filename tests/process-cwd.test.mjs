// Live cwd of a process. The parser is pure (lsof field output); getProcessCwd
// itself is exercised against this very test process, which is the only pid we
// can be sure exists and whose cwd we already know.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseLsofCwd, getProcessCwd } = await import(
  "../dist-electron/process-cwd.js"
);

test("parseLsofCwd takes the n line that follows fcwd", () => {
  // What `lsof -a -d cwd -p PID -Fn` prints: pid, then one record per fd.
  const out = "p59321\nfcwd\nn/Users/me/Projects/aya\n";
  assert.equal(parseLsofCwd(out), "/Users/me/Projects/aya");
});

test("parseLsofCwd tolerates extra field lines inside the record", () => {
  // Other -F selectors (access mode, lock) interleave their own lines.
  const out = "p1\nfcwd\na \nl \nn/tmp/here\n";
  assert.equal(parseLsofCwd(out), "/tmp/here");
});

test("parseLsofCwd ignores paths of other file descriptors", () => {
  // -a -d cwd should keep other fds out, but a path from one must never be
  // mistaken for the cwd if lsof does report extra records.
  const out = "p1\nftxt\nn/usr/bin/zsh\nfcwd\nn/tmp/here\nf3\nn/dev/null\n";
  assert.equal(parseLsofCwd(out), "/tmp/here");
});

test("parseLsofCwd returns null when there is no cwd record", () => {
  assert.equal(parseLsofCwd("p1\nftxt\nn/usr/bin/zsh\n"), null);
  assert.equal(parseLsofCwd(""), null);
});

test("parseLsofCwd keeps spaces in the path", () => {
  assert.equal(parseLsofCwd("fcwd\nn/tmp/my dir/repo\n"), "/tmp/my dir/repo");
});

test("getProcessCwd reads this process's own cwd", async (t) => {
  if (process.platform === "win32") {
    t.skip("no cwd lookup on Windows");
    return;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aya-cwd-")));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const cwd = await getProcessCwd(process.pid);
    assert.equal(cwd && realpathSync(cwd), dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getProcessCwd returns null for a bad pid instead of throwing", async () => {
  assert.equal(await getProcessCwd(-1), null);
  assert.equal(await getProcessCwd(0), null);
  // A pid far above the typical max: no such process, so no cwd.
  assert.equal(await getProcessCwd(4194303), null);
});
