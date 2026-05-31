// Status bar polls getGitInfo every 3s for the active project; if it ever
// throws or hangs the status bar goes blank. These tests pin the happy paths
// and the silent-failure contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  getGitChangedFiles,
  getGitDiff,
  getGitInfo,
  parseGitPorcelain,
} from "../dist-electron/git.js";

const execFileAsync = promisify(execFile);

async function initRepo(dir) {
  // -q to keep test output clean. We set user identity locally so commits work
  // without depending on the host's global git config.
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: dir,
  });
}

async function commitAll(dir, message) {
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

test("clean repo: reports branch and zero dirty files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "README.md"), "hello\n");
    await commitAll(dir, "initial");
    const info = await getGitInfo(dir);
    assert.equal(info.branch, "main");
    assert.equal(info.dirty, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("modified tracked file counts as one dirty entry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "one\n");
    await commitAll(dir, "initial");
    await writeFile(path.join(dir, "a.txt"), "two\n");
    const info = await getGitInfo(dir);
    assert.equal(info.branch, "main");
    assert.equal(info.dirty, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untracked files count toward dirty count", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "tracked.txt"), "x\n");
    await commitAll(dir, "initial");
    await writeFile(path.join(dir, "new-one.txt"), "a\n");
    await writeFile(path.join(dir, "new-two.txt"), "b\n");
    const info = await getGitInfo(dir);
    assert.equal(info.dirty, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("staged + unstaged + untracked all count (no dedup needed for status bar)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await writeFile(path.join(dir, "b.txt"), "b\n");
    await commitAll(dir, "initial");
    // Staged modification.
    await writeFile(path.join(dir, "a.txt"), "A\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    // Unstaged modification on a different file.
    await writeFile(path.join(dir, "b.txt"), "B\n");
    // Untracked file.
    await writeFile(path.join(dir, "c.txt"), "c\n");
    const info = await getGitInfo(dir);
    assert.equal(info.dirty, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getGitChangedFiles returns porcelain statuses and paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "a.txt"), "a\n");
    await writeFile(path.join(dir, "b.txt"), "b\n");
    await commitAll(dir, "initial");
    await writeFile(path.join(dir, "a.txt"), "A\n");
    await execFileAsync("git", ["add", "a.txt"], { cwd: dir });
    await writeFile(path.join(dir, "b.txt"), "B\n");
    await writeFile(path.join(dir, "c.txt"), "c\n");
    const files = await getGitChangedFiles(dir);
    assert.deepEqual(files, [
      { status: "M", path: "a.txt" },
      { status: "M", path: "b.txt" },
      { status: "??", path: "c.txt" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseGitPorcelain keeps rename paths readable", () => {
  assert.deepEqual(parseGitPorcelain("R  old.txt -> new.txt\n"), [
    { status: "R", path: "old.txt -> new.txt" },
  ]);
});

test("getGitDiff includes tracked changes and untracked files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "tracked.ts"), "const value = 1;\n");
    await commitAll(dir, "initial");
    await writeFile(path.join(dir, "tracked.ts"), "const value = 2;\n");
    await writeFile(path.join(dir, "new.ts"), "export const created = true;\n");
    const diff = await getGitDiff(dir);
    assert.match(diff, /diff --git a\/tracked\.ts b\/tracked\.ts/);
    assert.match(diff, /-const value = 1;/);
    assert.match(diff, /\+const value = 2;/);
    assert.match(diff, /diff --git a\/new\.ts b\/new\.ts/);
    assert.match(diff, /\+export const created = true;/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads the actual branch name (not just 'main')", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "x"), "x");
    await commitAll(dir, "initial");
    await execFileAsync("git", ["checkout", "-q", "-b", "feature/some-thing"], {
      cwd: dir,
    });
    const info = await getGitInfo(dir);
    assert.equal(info.branch, "feature/some-thing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-git directory returns null branch and zero dirty (silent fallback)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await writeFile(path.join(dir, "loose.txt"), "no repo\n");
    const info = await getGitInfo(dir);
    assert.deepEqual(info, { branch: null, dirty: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nonexistent directory returns the same silent fallback", async () => {
  const info = await getGitInfo("/this/path/does/not/exist/aya-test");
  assert.deepEqual(info, { branch: null, dirty: 0 });
});

test("repo with no commits yet still returns a usable shape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    // No commits. `git rev-parse --abbrev-ref HEAD` errors here, so getGitInfo
    // should hit the catch and return nulls instead of crashing the status bar.
    const info = await getGitInfo(dir);
    assert.equal(info.branch, null);
    assert.equal(info.dirty, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("subdirectory of a repo still reports the parent repo's branch", async () => {
  // Status bar polls the project's root directory, but Aya users sometimes
  // open a subdir as a project. git --abbrev-ref HEAD respects the enclosing
  // worktree by walking up, so this should just work.
  const dir = await mkdtemp(path.join(tmpdir(), "aya-git-"));
  try {
    await initRepo(dir);
    await writeFile(path.join(dir, "root.txt"), "x");
    await commitAll(dir, "initial");
    const sub = path.join(dir, "nested", "deep");
    await mkdir(sub, { recursive: true });
    const info = await getGitInfo(sub);
    assert.equal(info.branch, "main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
