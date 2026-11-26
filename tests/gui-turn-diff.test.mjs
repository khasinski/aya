// Per-turn diffs for Conversation GUI panes: snapshots of the working tree in a private index, the diff between two
// of them, commits of the branch, and the renderer's path helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuiTurnDiffs, changedFiles, commitDiff, diffSnapshots, handleGuiDiffAction, listBranchCommits, snapshotWorkingTree } from "../dist-electron/gui-turn-diff.js";
import { fileChangePaths, parseDiffSourceId, repoRelativePath, turnDiffsOf, turnDiffSummaryText } from "../dist-test/gui-turn-diff.js";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "aya-turn-diff-"));
  const git = (...args) => execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: dir, stdio: "pipe" }).toString().trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "before.txt"), "base\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a non-git folder has no snapshot, and the diff actions say why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-turn-plain-"));
  try {
    assert.equal(await snapshotWorkingTree(dir), null);
    await assert.rejects(handleGuiDiffAction(new GuiTurnDiffs(), "k", dir, "diff-turn", {}), /not in a git repository/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a turn's diff holds only what changed between its snapshots, and the user's index and stash are untouched", async () => {
  const { dir, git, done } = repo();
  try {
    // Edited before the turn, so not part of it.
    writeFileSync(join(dir, "before.txt"), "edited before the turn\n");
    git("add", "before.txt");
    const index = join(dir, ".git", "index");
    const indexBefore = readFileSync(index);
    const start = await snapshotWorkingTree(dir);
    assert.ok(start);
    assert.match(start.tree, /^[0-9a-f]{40}$/);
    assert.equal(start.head, git("rev-parse", "HEAD"));
    // The turn: one tracked edit, one new file, one ignored file.
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "new.txt"), "fresh\n");
    writeFileSync(join(dir, "ignored.log"), "noise\n");
    const end = await snapshotWorkingTree(join(dir, "src"));
    assert.ok(end);
    assert.equal(end.root, start.root);
    const diff = await diffSnapshots(dir, start.tree, end.tree);
    assert.match(diff, /diff --git a\/a\.txt b\/a\.txt/);
    assert.match(diff, /\+three/);
    assert.match(diff, /b\/src\/new\.txt/);
    assert.doesNotMatch(diff, /before\.txt|ignored\.log/);
    assert.deepEqual(await changedFiles(dir, start.tree, end.tree), [
      { path: "a.txt", additions: 1, deletions: 0 },
      { path: "src/new.txt", additions: 1, deletions: 0 },
    ]);
    assert.deepEqual(readFileSync(index), indexBefore);
    assert.equal(git("diff", "--cached", "--name-only"), "before.txt");
    assert.equal(git("stash", "list"), "");
    assert.equal(git("for-each-ref", "--format=%(refname)"), "refs/heads/main");
  } finally { done(); }
});

test("a pull or commit between turns is not part of the next turn", async () => {
  const { dir, git, done } = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "changed by the user\n");
    git("commit", "-qam", "user work between turns");
    const start = await snapshotWorkingTree(dir);
    writeFileSync(join(dir, "before.txt"), "agent\n");
    const end = await snapshotWorkingTree(dir);
    assert.deepEqual((await changedFiles(dir, start.tree, end.tree)).map(f => f.path), ["before.txt"]);
  } finally { done(); }
});

test("a snapshot over the time limit is abandoned", async () => {
  const { dir, done } = repo();
  try { assert.equal(await snapshotWorkingTree(dir, 1), null); } finally { done(); }
});

test("a pruned snapshot gives a readable error", async () => {
  const { dir, done } = repo();
  try { await assert.rejects(diffSnapshots(dir, "1".repeat(40), "2".repeat(40)), /no longer in the repository/); } finally { done(); }
});

test("the tracker reports a finished turn that changed files, and nothing for one that did not", async () => {
  const { dir, done } = repo();
  try {
    const diffs = new GuiTurnDiffs(), events = [];
    const emit = event => events.push(event);
    await diffs.beginTurn("pane", dir);
    diffs.observe("pane", dir, { method: "turn/started", params: { turn: { id: "t1" } } }, emit);
    const running = await handleGuiDiffAction(diffs, "pane", dir, "diff-turn", {});
    assert.equal(running.diff, "");
    writeFileSync(join(dir, "a.txt"), "turn one\n");
    assert.match((await handleGuiDiffAction(diffs, "pane", dir, "diff-turn", {})).diff, /\+turn one/);
    diffs.observe("pane", dir, { method: "turn/completed", params: { turn: { id: "t1", status: "completed" } } }, emit);
    await new Promise(resolve => { const wait = () => events.length ? resolve() : setTimeout(wait, 20); wait(); });
    const [{ method, params: { turnDiff } }] = events;
    assert.equal(method, "aya/turnDiff");
    assert.equal(turnDiff.turnId, "t1");
    assert.deepEqual(turnDiff.files.map(f => f.path), ["a.txt"]);
    const saved = await handleGuiDiffAction(diffs, "pane", dir, "diff-turn", { start: turnDiff.start, end: turnDiff.end });
    assert.match(saved.diff, /\+turn one/);
    await assert.rejects(handleGuiDiffAction(diffs, "pane", dir, "diff-turn", {}), /No snapshot/);

    await diffs.beginTurn("pane", dir);
    diffs.observe("pane", dir, { method: "turn/completed", params: { turn: { id: "t2" } } }, emit);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(events.length, 1);
  } finally { done(); }
});

test("commits of a branch are listed against the default branch, or since the conversation began", async () => {
  const { dir, git, done } = repo();
  try {
    const sessionStart = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feature");
    writeFileSync(join(dir, "a.txt"), "feature one\n"); git("commit", "-qam", "First feature commit");
    writeFileSync(join(dir, "b.txt"), "b\n"); git("add", "b.txt"); git("commit", "-qm", "Second feature commit");
    const branch = await listBranchCommits(dir, null);
    assert.equal(branch.label, "Commits not on main");
    assert.deepEqual(branch.commits.map(c => c.subject), ["Second feature commit", "First feature commit"]);
    const shown = await commitDiff(dir, branch.commits[1].sha);
    assert.match(shown, /\+feature one/);
    assert.doesNotMatch(shown, /b\.txt/);
    await assert.rejects(commitDiff(dir, "f".repeat(40)), /not in this repository/);

    git("checkout", "-q", "main");
    git("merge", "-q", "--ff-only", "feature");
    assert.deepEqual((await listBranchCommits(dir, null)).commits, []);
    const since = await listBranchCommits(dir, sessionStart);
    assert.equal(since.label, "Commits made during this conversation");
    assert.equal(since.commits.length, 2);
  } finally { done(); }
});

test("file-change activities name their files, and paths are made relative to the repository", () => {
  assert.deepEqual(fileChangePaths({ type: "fileChange", changes: [{ path: "/r/a.ts" }, { path: "/r/a.ts" }, { path: "/r/b.ts" }] }), ["/r/a.ts", "/r/b.ts"]);
  assert.deepEqual(fileChangePaths({ type: "fileChange", tool: "edit", command: "src/x.ts" }), ["src/x.ts"]);
  assert.deepEqual(fileChangePaths({ type: "fileChange", tool: "Edit", command: "Edit" }), []);
  assert.deepEqual(fileChangePaths({ type: "commandExecution", command: "ls" }), []);
  const where = { root: "/private/var/repo", prefix: "pkg/", cwd: "/var/repo/pkg" };
  assert.equal(repoRelativePath("/private/var/repo/a.ts", where), "a.ts");
  assert.equal(repoRelativePath("/var/repo/pkg/b.ts", where), "pkg/b.ts");
  assert.equal(repoRelativePath("/var/repo/c.ts", where), "c.ts");
  assert.equal(repoRelativePath("./d.ts", where), "pkg/d.ts");
  assert.equal(turnDiffSummaryText([{ path: "a", additions: 2, deletions: 1 }, { path: "b", additions: null, deletions: null }]), "2 files changed · +2 −1");
  const turn = { id: "x", turnId: "", root: "/r", start: "a", end: "b", startHead: null, files: [] };
  assert.deepEqual(parseDiffSourceId("turn:x", [turn]), { kind: "turn", summary: turn });
  assert.equal(parseDiffSourceId("turn:y", [turn]), null);
  assert.deepEqual(parseDiffSourceId("current", []), { kind: "current" });
  assert.equal(parseDiffSourceId("commit:nothex", []), null);
});

test("the turn summaries keep their identity while a reply streams, so the open diff viewer does not re-render", () => {
  const a = { id: "a", files: [] }, b = { id: "b", files: [] };
  const messages = [{ type: "user", text: "x" }, { type: "turnDiff", turnDiff: a }, { type: "assistant", text: "partial" }];
  const first = turnDiffsOf(messages);
  assert.deepEqual(first, [a]);
  // A streamed delta replaces the assistant message; the summaries are the same.
  assert.equal(turnDiffsOf([...messages.slice(0, 2), { type: "assistant", text: "partial reply" }], first), first);
  const second = turnDiffsOf([...messages, { type: "turnDiff", turnDiff: b }], first);
  assert.notEqual(second, first);
  assert.deepEqual(second, [a, b]);
});
