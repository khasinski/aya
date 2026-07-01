// Worktree detection: the pure parser (parseWorktrees) against the shapes
// `git worktree list --porcelain` emits, plus integration tests that run the
// real `listWorktrees` against throwaway repos with actual `git worktree add`
// so they catch regressions in the git invocation itself, not just parsing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { parseWorktrees, listWorktrees } = await import(
  "../dist-electron/git.js"
);

// --- parseWorktrees (pure) ---------------------------------------------------

const SAMPLE = `worktree /Users/hasik/Projects/aya
HEAD 415f9ba5afe047ffdf272acf263fae7cba775e6b
branch refs/heads/main

worktree /private/tmp/aya-pages-0.6
HEAD 0af9b5868ae1ca8a7f9ce274d7ccc1e00b92515a
branch refs/heads/project-page-custom-domain
prunable gitdir file points to non-existent location

worktree /Users/hasik/Projects/aya-latest-build
HEAD 21f8cbc3a01eb2a93ead6b8a84143e9e2dc80491
detached
`;

test("parseWorktrees returns one entry per block with branch + flags", () => {
  const wts = parseWorktrees(SAMPLE);
  assert.equal(wts.length, 3);
  assert.deepEqual(wts[0], {
    path: "/Users/hasik/Projects/aya",
    branch: "main",
    isMain: true,
    detached: false,
    bare: false,
    prunable: false,
  });
  assert.equal(wts[1].branch, "project-page-custom-domain");
  assert.equal(wts[1].isMain, false);
  assert.equal(wts[1].prunable, true);
  assert.equal(wts[2].branch, null);
  assert.equal(wts[2].detached, true);
});

test("only the first block is the main worktree", () => {
  const wts = parseWorktrees(SAMPLE);
  assert.equal(wts.filter((w) => w.isMain).length, 1);
  assert.equal(wts[0].isMain, true);
});

test("a bare repo block is flagged bare with no branch", () => {
  const wts = parseWorktrees("worktree /repo/bare\nbare\n");
  assert.equal(wts.length, 1);
  assert.equal(wts[0].bare, true);
  assert.equal(wts[0].branch, null);
});

test("branch names keep their slashes (refs/heads/ prefix stripped)", () => {
  const wts = parseWorktrees(
    "worktree /r\nHEAD abc\nbranch refs/heads/feature/deep/name\n",
  );
  assert.equal(wts[0].branch, "feature/deep/name");
});

test("CRLF line endings parse the same as LF", () => {
  const crlf = SAMPLE.replace(/\n/g, "\r\n");
  assert.deepEqual(parseWorktrees(crlf), parseWorktrees(SAMPLE));
});

test("a `locked` line (with or without reason) is tolerated, not misread", () => {
  const wts = parseWorktrees(
    "worktree /r/a\nHEAD abc\nbranch refs/heads/main\nlocked\n\n" +
      "worktree /r/b\nHEAD def\nbranch refs/heads/wip\nlocked under review\n",
  );
  assert.equal(wts.length, 2);
  assert.equal(wts[0].branch, "main");
  assert.equal(wts[1].branch, "wip");
  // No flag is flipped by a locked line.
  assert.equal(wts[1].detached, false);
  assert.equal(wts[1].bare, false);
  assert.equal(wts[1].prunable, false);
});

test("a final block with no trailing newline still parses", () => {
  const wts = parseWorktrees("worktree /r/a\nHEAD abc\nbranch refs/heads/main");
  assert.equal(wts.length, 1);
  assert.equal(wts[0].branch, "main");
});

test("empty input yields no worktrees", () => {
  assert.deepEqual(parseWorktrees(""), []);
  assert.deepEqual(parseWorktrees("\n\n"), []);
});

// --- listWorktrees (integration, real git) -----------------------------------

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "aya-wt-repo-"));
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@aya.invalid", { cwd: root });
  execSync('git config user.name "Aya Test"', { cwd: root });
  execSync("git config commit.gpgsign false", { cwd: root });
  writeFileSync(join(root, "a.txt"), "hello");
  execSync("git add -A", { cwd: root });
  execSync("git commit -q -m init", { cwd: root });
  return root;
}

const trash = [];
function tmpWorktreePath(name) {
  const parent = mkdtempSync(join(tmpdir(), "aya-wt-linked-"));
  trash.push(parent);
  return join(parent, name);
}
test.after(() => {
  for (const p of trash) rmSync(p, { recursive: true, force: true });
});

test("listWorktrees on a fresh repo returns just the main worktree", async () => {
  const root = makeRepo();
  try {
    const wts = await listWorktrees(root);
    assert.equal(wts.length, 1);
    assert.equal(wts[0].isMain, true);
    assert.equal(wts[0].branch, "main");
    assert.equal(wts[0].detached, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorktrees reports a linked branch worktree, main flagged once", async () => {
  const root = makeRepo();
  const feature = tmpWorktreePath("feature");
  try {
    execSync(`git worktree add "${feature}" -b feature`, { cwd: root });
    const wts = await listWorktrees(root);
    assert.equal(wts.length, 2);
    assert.equal(wts.filter((w) => w.isMain).length, 1);
    const branches = wts.map((w) => w.branch).sort();
    assert.deepEqual(branches, ["feature", "main"]);
    assert.equal(wts.find((w) => w.branch === "main").isMain, true);
    assert.equal(wts.find((w) => w.branch === "feature").isMain, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a detached worktree reports branch=null, detached=true", async () => {
  const root = makeRepo();
  const detached = tmpWorktreePath("detached");
  try {
    execSync(`git worktree add --detach "${detached}" HEAD`, { cwd: root });
    const wts = await listWorktrees(root);
    const d = wts.find((w) => !w.isMain);
    assert.ok(d, "linked worktree present");
    assert.equal(d.branch, null);
    assert.equal(d.detached, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorktrees works from a LINKED worktree too (git sees all)", async () => {
  const root = makeRepo();
  const feature = tmpWorktreePath("feature");
  try {
    execSync(`git worktree add "${feature}" -b feature`, { cwd: root });
    // Query from the linked worktree, not the main checkout.
    const wts = await listWorktrees(feature);
    assert.equal(wts.length, 2);
    assert.equal(wts.filter((w) => w.isMain).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorktrees returns [] for a non-repo directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-wt-nonrepo-"));
  try {
    assert.deepEqual(await listWorktrees(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listWorktrees returns [] (no throw) for a missing directory", async () => {
  assert.deepEqual(await listWorktrees("/no/such/dir/aya-xyz-123"), []);
});
