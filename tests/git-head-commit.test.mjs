// Team messages carry the sender's commit, so a reader can tell stale news.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headCommit } from "../dist-electron/git.js";

test("headCommit is the short HEAD hash, and null outside a repo or before a commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-head-"));
  try {
    assert.equal(await headCommit(dir), null);
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
    git("init", "-q");
    assert.equal(await headCommit(dir), null);
    writeFileSync(join(dir, "f"), "x");
    git("add", "f");
    git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "one");
    assert.equal(await headCommit(dir), git("rev-parse", "--short", "HEAD"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
