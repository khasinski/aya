// Parser for `git worktree list --porcelain`. Covers the shapes the worktree
// feature depends on: the primary worktree, a linked branch worktree, a
// detached worktree, and a prunable one (stale gitdir).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorktrees } from "../dist-electron/git.js";

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

  assert.equal(wts[1].path, "/private/tmp/aya-pages-0.6");
  assert.equal(wts[1].branch, "project-page-custom-domain");
  assert.equal(wts[1].isMain, false);
  assert.equal(wts[1].prunable, true);

  assert.equal(wts[2].branch, null);
  assert.equal(wts[2].detached, true);
  assert.equal(wts[2].isMain, false);
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

test("empty input yields no worktrees", () => {
  assert.deepEqual(parseWorktrees(""), []);
});
