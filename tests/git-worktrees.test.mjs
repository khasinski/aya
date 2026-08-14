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

const { parseWorktrees, listWorktrees, createWorktree, removeWorktree } =
  await import("../dist-electron/git.js");

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

// --- mutations -------------------------------------------------------------
// The first git commands in Aya that CHANGE a repository. Unlike every read
// (which degrades to an empty result), these must report failure: "a branch
// named 'x' already exists" is information the user needs in order to act.

test("createWorktree makes a new checkout on a new branch", async () => {
  const repo = makeRepo();
  const wtPath = tmpWorktreePath("feature");
  const result = await createWorktree(repo, wtPath, "feature");
  assert.equal(result.ok, true, result.ok ? "" : result.error);

  const list = await listWorktrees(repo);
  // Compare by basename: macOS resolves /var -> /private/var, so the absolute
  // path git reports is not literally the one we passed in.
  const added = list.find((w) => w.path.endsWith("/feature"));
  assert.ok(added, "the new worktree should be listed");
  assert.equal(added.branch, "feature");
  assert.equal(added.isMain, false);
});

test("creating a branch that already exists FAILS with git's message", async () => {
  const repo = makeRepo();
  await createWorktree(repo, tmpWorktreePath("dup"), "dup");
  const again = await createWorktree(
    repo,
    tmpWorktreePath("dup2"),
    "dup",
  );
  assert.equal(again.ok, false);
  assert.match(again.error, /already exists/i);
  // The message must be usable in a dialog, not a raw multi-line dump.
  assert.ok(!again.error.includes("\n"));
  assert.ok(!/^fatal:/i.test(again.error), "the fatal: prefix is noise");
});

test("removeWorktree drops the checkout but keeps the branch", async () => {
  const repo = makeRepo();
  const wtPath = tmpWorktreePath("gone");
  await createWorktree(repo, wtPath, "gone");
  const removed = await removeWorktree(repo, wtPath);
  assert.equal(removed.ok, true, removed.ok ? "" : removed.error);

  const list = await listWorktrees(repo);
  assert.equal(list.some((w) => w.path.endsWith("/gone")), false);
  const branches = execSync("git branch --list gone", { cwd: repo }).toString();
  assert.match(branches, /gone/, "the branch itself must survive");
});

test("removing an unknown path fails instead of reporting success", async () => {
  const repo = makeRepo();
  const result = await removeWorktree(repo, tmpWorktreePath("never-existed"));
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test("a dirty worktree is refused without force, and removed with it", async () => {
  // Losing uncommitted work must be a deliberate choice, so the default
  // refuses and the caller decides whether to escalate.
  const repo = makeRepo();
  const wtPath = tmpWorktreePath("dirty");
  await createWorktree(repo, wtPath, "dirty");
  writeFileSync(join(wtPath, "scratch.txt"), "uncommitted work");

  const refused = await removeWorktree(repo, wtPath);
  assert.equal(refused.ok, false, "a dirty worktree must not vanish silently");

  const forced = await removeWorktree(repo, wtPath, true);
  assert.equal(forced.ok, true, forced.ok ? "" : forced.error);
});

test("the surfaced error is git's reason, not its progress chatter", async () => {
  // Regression: git writes progress to stderr too, so taking the FIRST line
  // showed "Preparing worktree (new branch 'x')" — which tells the user
  // nothing about why the operation failed.
  const repo = makeRepo();
  await createWorktree(repo, tmpWorktreePath("chatter"), "chatter");
  const again = await createWorktree(repo, tmpWorktreePath("chatter2"), "chatter");
  assert.equal(again.ok, false);
  assert.doesNotMatch(again.error, /Preparing worktree/i);
  assert.match(again.error, /already exists/i);
});
