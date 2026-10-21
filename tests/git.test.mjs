// Tests for the status-bar git wrapper. parseGitPorcelain is exercised purely;
// the async getters run against a throwaway repo in os.tmpdir so they catch
// regressions in the actual git invocations / parsing of real output.
//
// Each test creates and destroys its own repo so they're independent and can
// run in parallel. We pin the default branch to "main" and disable gpg signing
// + per-repo identity so the suite never depends on the host git config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeRepo } from "./helpers/git.mjs";

const REPO_PREFIX = "aya-git-";

const {
  parseGitPorcelain,
  getGitInfo,
  getGitChangedFiles,
  getGitDiff,
  commitGitFiles,
} = await import("../dist-electron/git.js");

function commit(root, file, content, message = "init") {
  writeFileSync(join(root, file), content);
  execSync(`git add -- ${file}`, { cwd: root });
  execSync(`git commit -q -m '${message}'`, { cwd: root });
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// --- parseGitPorcelain (pure) ------------------------------------------------

test("parseGitPorcelain returns [] for empty input", () => {
  assert.deepEqual(parseGitPorcelain(""), []);
  assert.deepEqual(parseGitPorcelain("\n\n"), []);
});

test("parseGitPorcelain parses status + path for common shapes", () => {
  const status = [
    " M src/App.tsx",
    "?? note.md",
    "A  added.txt",
    "MM tracked-and-staged.ts",
  ].join("\n");
  assert.deepEqual(parseGitPorcelain(status), [
    { status: "M", path: "src/App.tsx" },
    { status: "??", path: "note.md" },
    { status: "A", path: "added.txt" },
    { status: "MM", path: "tracked-and-staged.ts" },
  ]);
});

test("parseGitPorcelain ignores blank lines between entries", () => {
  const out = parseGitPorcelain(" M a\n\n?? b\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "a");
  assert.equal(out[1].path, "b");
});

// --- getGitInfo ----------------------------------------------------------------

test("getGitInfo: a clean main-branch repo reports branch=main and dirty=0", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    const info = await getGitInfo(root);
    assert.equal(info.branch, "main");
    assert.equal(info.dirty, 0);
  } finally {
    cleanup(root);
  }
});

test("getGitInfo: untracked file bumps dirty count", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    writeFileSync(join(root, "new.txt"), "fresh\n");
    const info = await getGitInfo(root);
    assert.equal(info.dirty, 1);
  } finally {
    cleanup(root);
  }
});

test("getGitInfo: a modified tracked file counts as dirty", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "old\n");
    writeFileSync(join(root, "a.txt"), "new\n");
    const info = await getGitInfo(root);
    assert.equal(info.dirty, 1);
    assert.equal(info.branch, "main");
  } finally {
    cleanup(root);
  }
});

test("getGitInfo: a non-repo directory returns nulls without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-git-norepo-"));
  try {
    const info = await getGitInfo(root);
    assert.equal(info.branch, null);
    assert.equal(info.dirty, 0);
  } finally {
    cleanup(root);
  }
});

test("getGitInfo: a missing directory returns nulls without throwing", async () => {
  const info = await getGitInfo("/does/not/exist/aya-test");
  assert.equal(info.branch, null);
  assert.equal(info.dirty, 0);
});

// --- getGitChangedFiles --------------------------------------------------------

test("getGitChangedFiles: clean repo returns []", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    const files = await getGitChangedFiles(root);
    assert.deepEqual(files, []);
  } finally {
    cleanup(root);
  }
});

test("getGitChangedFiles: surfaces modified + untracked files with porcelain statuses", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "old\n");
    writeFileSync(join(root, "a.txt"), "new\n");
    writeFileSync(join(root, "fresh.txt"), "yo\n");
    const files = await getGitChangedFiles(root);
    const byPath = new Map(files.map((f) => [f.path, f.status]));
    assert.equal(byPath.get("a.txt"), "M");
    assert.equal(byPath.get("fresh.txt"), "??");
    assert.equal(files.length, 2);
  } finally {
    cleanup(root);
  }
});

test("getGitChangedFiles: non-repo returns [] (no throw)", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-git-norepo-"));
  try {
    assert.deepEqual(await getGitChangedFiles(root), []);
  } finally {
    cleanup(root);
  }
});

test("getGitChangedFiles preserves spaces and reports deleted files", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    writeFileSync(join(root, "file with spaces.txt"), "new\n");
    unlinkSync(join(root, "a.txt"));
    const files = await getGitChangedFiles(root);
    assert.deepEqual(files.map((file) => file.path).sort(), ["a.txt", "file with spaces.txt"]);
    assert.equal(files.find((file) => file.path === "a.txt").status, "D");
  } finally {
    cleanup(root);
  }
});

test("commitGitFiles commits only selected modified, deleted and untracked paths", async () => {
  const root = makeRepo(REPO_PREFIX);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  try {
    for (const name of ["selected.txt", "staged.txt", "removed.txt"]) writeFileSync(join(root, name), `${name}\n`);
    git("add", "--", "selected.txt", "staged.txt", "removed.txt");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "initial");
    writeFileSync(join(root, "selected.txt"), "selected update\n");
    writeFileSync(join(root, "staged.txt"), "keep staged\n");
    git("add", "--", "staged.txt");
    unlinkSync(join(root, "removed.txt"));
    writeFileSync(join(root, "new file.txt"), "new content\n");
    writeFileSync(join(root, "--option-like.txt"), "safe path\n");

    const result = await commitGitFiles(root, ["selected.txt", "removed.txt", "new file.txt", "--option-like.txt"], "Selected files only");
    assert.equal(result.ok, true);
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    const names = git("show", "--pretty=", "--name-only", "HEAD").toString().trim().split("\n").sort();
    assert.deepEqual(names, ["--option-like.txt", "new file.txt", "removed.txt", "selected.txt"]);
    assert.match(git("status", "--porcelain").toString(), /^M  staged\.txt$/m);
    assert.equal(git("show", "HEAD:--option-like.txt").toString(), "safe path\n");
  } finally {
    cleanup(root);
  }
});

test("commitGitFiles treats pathspec magic as literal for both add and commit", async () => {
  const root = makeRepo(REPO_PREFIX);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  try {
    commit(root, "base.txt", "base\n");
    for (const name of [":(glob)*", "a*.txt", "a1.txt", "unselected.txt"])
      writeFileSync(join(root, name), `contents of ${name}\n`);

    const magic = await commitGitFiles(root, [":(glob)*"], "Commit literal pathspec-looking name");
    assert.equal(magic.ok, true);
    assert.deepEqual(git("show", "--pretty=", "--name-only", "HEAD").toString().trim().split("\n"), [":(glob)*"]);
    assert.equal(git("status", "--porcelain").toString().includes("unselected.txt"), true);
    assert.equal(git("status", "--porcelain").toString().includes("a1.txt"), true);

    const glob = await commitGitFiles(root, ["a*.txt"], "Commit literal glob-looking name");
    assert.equal(glob.ok, true);
    assert.deepEqual(git("show", "--pretty=", "--name-only", "HEAD").toString().trim().split("\n"), ["a*.txt"]);
    assert.equal(git("status", "--porcelain").toString().includes("a1.txt"), true);
    assert.equal(git("status", "--porcelain").toString().includes("unselected.txt"), true);
  } finally {
    cleanup(root);
  }
});

test("commitGitFiles includes both sides of a selected rename", async () => {
  const root = makeRepo(REPO_PREFIX);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  try {
    writeFileSync(join(root, "old name.txt"), "original\n");
    git("add", "--", "old name.txt");
    git("commit", "-m", "initial");
    git("mv", "--", "old name.txt", "new name.txt");
    const result = await commitGitFiles(root, ["new name.txt"], "Rename selected file");
    assert.equal(result.ok, true);
    assert.deepEqual(git("show", "--pretty=", "--name-status", "HEAD").toString().trim().split("\n"), ["R100\told name.txt\tnew name.txt"]);
    assert.throws(() => git("cat-file", "-e", "HEAD:old name.txt"));
    assert.equal(git("show", "HEAD:new name.txt").toString(), "original\n");
  } finally {
    cleanup(root);
  }
});

test("commitGitFiles returns a status error instead of claiming the selection changed", async () => {
  const directory = mkdtempSync(join(tmpdir(), REPO_PREFIX));
  try {
    writeFileSync(join(directory, "a.txt"), "content\n");
    const result = await commitGitFiles(directory, ["a.txt"], "Try commit");
    assert.equal(result.ok, false);
    assert.match(result.error, /not a git repository/i);
  } finally {
    cleanup(directory);
  }
});

test("commitGitFiles returns git hook errors and leaves the selected change available", async () => {
  const root = makeRepo(REPO_PREFIX);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  try {
    for (const name of ["a.txt", "staged.txt"]) writeFileSync(join(root, name), `${name} before\n`);
    git("add", "--", "a.txt", "staged.txt");
    git("commit", "-m", "initial");
    writeFileSync(join(root, "a.txt"), "after\n");
    writeFileSync(join(root, "staged.txt"), "already staged\n");
    git("add", "--", "staged.txt");
    writeFileSync(join(root, "new.txt"), "new and selected\n");
    const statusBefore = git("status", "--porcelain").toString();
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const result = await commitGitFiles(root, ["a.txt", "new.txt"], "keep this message");
    assert.deepEqual(result, { ok: false, error: "hook says no" });
    assert.equal(git("status", "--porcelain").toString(), statusBefore, "a failed commit restores only its added paths and preserves existing index state");
    assert.equal(git("rev-list", "--count", "HEAD").toString().trim(), "1");
  } finally {
    cleanup(root);
  }
});

test("commitGitFiles removes newly staged paths after a failed first commit in an unborn repo", async () => {
  const root = makeRepo(REPO_PREFIX);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
  try {
    git("config", "user.name", "");
    git("config", "user.email", "");
    writeFileSync(join(root, "first.txt"), "first commit\n");
    const statusBefore = git("status", "--porcelain").toString();
    const result = await commitGitFiles(root, ["first.txt"], "No identity");
    assert.equal(result.ok, false);
    assert.match(result.error, /identity|name|email/i);
    assert.equal(git("status", "--porcelain").toString(), statusBefore);
  } finally {
    cleanup(root);
  }
});

// --- getGitDiff ----------------------------------------------------------------

test("getGitDiff: clean repo returns the empty string", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    assert.equal(await getGitDiff(root), "");
  } finally {
    cleanup(root);
  }
});

test("getGitDiff: a modified tracked file produces a real diff hunk", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "one\ntwo\n");
    writeFileSync(join(root, "a.txt"), "one\nTWO\n");
    const diff = await getGitDiff(root);
    assert.match(diff, /diff --git a\/a\.txt b\/a\.txt/);
    assert.match(diff, /^-two$/m);
    assert.match(diff, /^\+TWO$/m);
  } finally {
    cleanup(root);
  }
});

test("getGitDiff: an untracked text file is included as a synthetic new-file diff", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    writeFileSync(join(root, "new.md"), "line1\nline2\n");
    const diff = await getGitDiff(root);
    assert.match(diff, /diff --git a\/new\.md b\/new\.md/);
    assert.match(diff, /^new file mode 100644$/m);
    assert.match(diff, /^\+line1$/m);
    assert.match(diff, /^\+line2$/m);
    assert.match(diff, /@@ -0,0 \+1,2 @@/);
  } finally {
    cleanup(root);
  }
});

test("getGitDiff: an untracked binary file (NUL bytes) is NOT included", async () => {
  const root = makeRepo(REPO_PREFIX);
  try {
    commit(root, "a.txt", "hi\n");
    // A NUL byte triggers the "binary" guard in syntheticNewFileDiff().
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x01, 0x00, 0x02, 0x03]));
    const diff = await getGitDiff(root);
    assert.equal(diff.includes("bin.dat"), false);
  } finally {
    cleanup(root);
  }
});

test("getGitDiff: non-repo returns the empty string (no throw)", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-git-norepo-"));
  try {
    assert.equal(await getGitDiff(root), "");
  } finally {
    cleanup(root);
  }
});
