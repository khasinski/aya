// Tests for the status-bar git wrapper. parseGitPorcelain is exercised purely;
// the async getters run against a throwaway repo in os.tmpdir so they catch
// regressions in the actual git invocations / parsing of real output.
//
// Each test creates and destroys its own repo so they're independent and can
// run in parallel. We pin the default branch to "main" and disable gpg signing
// + per-repo identity so the suite never depends on the host git config.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  parseGitPorcelain,
  getGitInfo,
  getGitChangedFiles,
  getGitDiff,
} = await import("../dist-electron/git.js");

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "aya-git-"));
  // -q silences hint output; -b pins the branch so the tests don't depend on
  // the host git's init.defaultBranch.
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@aya.invalid", { cwd: root });
  execSync('git config user.name "Aya Test"', { cwd: root });
  execSync("git config commit.gpgsign false", { cwd: root });
  return root;
}

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
  const root = makeRepo();
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
  const root = makeRepo();
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
  const root = makeRepo();
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
  const root = makeRepo();
  try {
    commit(root, "a.txt", "hi\n");
    const files = await getGitChangedFiles(root);
    assert.deepEqual(files, []);
  } finally {
    cleanup(root);
  }
});

test("getGitChangedFiles: surfaces modified + untracked files with porcelain statuses", async () => {
  const root = makeRepo();
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

// --- getGitDiff ----------------------------------------------------------------

test("getGitDiff: clean repo returns the empty string", async () => {
  const root = makeRepo();
  try {
    commit(root, "a.txt", "hi\n");
    assert.equal(await getGitDiff(root), "");
  } finally {
    cleanup(root);
  }
});

test("getGitDiff: a modified tracked file produces a real diff hunk", async () => {
  const root = makeRepo();
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
  const root = makeRepo();
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
  const root = makeRepo();
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
