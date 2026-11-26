// Per-turn diffs for Conversation GUI panes: snapshots of the working tree in a private index, the diff between two
// of them, commits of the branch, and the renderer's path helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { GuiTurnDiffs, MAX_LARGE_NAMES, MAX_TURN_DIFF_FILES, largeFilesChanged, stopAllSnapshots, SEND_WAIT_MS, SNAPSHOT_FILE_LIMIT, changedFiles, commitDiff, diffSnapshots, handleGuiDiffAction, listBranchCommits, repositoryOf, snapshotWorkingTree, sweepSnapshotTemp } from "../dist-electron/gui-turn-diff.js";
import { GuiPanelState } from "../dist-electron/gui-panel-state.js";
import { fileChangePaths, largeFilesText, parseDiffSourceId, repoRelativePath, turnDiffSummaryText } from "../dist-test/gui-turn-diff.js";

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

const waitForEvent = events => new Promise(resolve => { const wait = () => events.length ? resolve() : setTimeout(wait, 20); wait(); });
const objectExists = (git, sha) => { try { git("cat-file", "-e", sha); return true; } catch { return false; } };

test("a snapshot leaves out files over the size limit, so they are never copied into .git/objects", async () => {
  const { dir, git, done } = repo();
  try {
    const big = Buffer.alloc(SNAPSHOT_FILE_LIMIT + 1, 7);
    writeFileSync(join(dir, "big.db"), big);
    writeFileSync(join(dir, "small.txt"), "small\n");
    const bigSha = execFileSync("git", ["hash-object", "--stdin"], { input: big }).toString().trim();
    const snapshot = await snapshotWorkingTree(dir);
    assert.ok(snapshot);
    const files = git("ls-tree", "-r", "--name-only", snapshot.tree).split("\n");
    assert.ok(files.includes("small.txt"));
    assert.ok(!files.includes("big.db"));
    assert.equal(objectExists(git, bigSha), false, "the large file was not hashed into the repository");
  } finally { done(); }
});

test("a snapshot runs no clean filter (git-lfs and the like)", async () => {
  const { dir, git, done } = repo();
  try {
    const marker = join(dir, "..", `filter-ran-${Date.now()}`);
    git("config", "filter.probe.clean", `touch '${marker}'; cat`);
    git("config", "filter.probe.required", "true");
    writeFileSync(join(dir, ".gitattributes"), "*.bin filter=probe\n");
    writeFileSync(join(dir, "a.bin"), "raw\n");
    const snapshot = await snapshotWorkingTree(dir);
    assert.ok(snapshot);
    assert.equal(git("cat-file", "-p", `${snapshot.tree}:a.bin`), "raw");
    assert.equal(existsSync(marker), false, "the filter never ran");
  } finally { done(); }
});

test("the repository is found from a subfolder with an absolute index path", async () => {
  const { dir, done } = repo();
  try {
    mkdirSync(join(dir, "sub"));
    const found = await repositoryOf(join(dir, "sub"));
    assert.equal(found.prefix, "sub/");
    assert.ok(isAbsolute(found.index) && existsSync(found.index), found.index);
  } finally { done(); }
});

test("temp folders a quit left behind mid-snapshot are swept once old, fresh ones are kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-sweep-"));
  try {
    for (const name of ["aya-turn-old", "aya-turn-new", "aya-snapshot-x.index", "unrelated"]) mkdirSync(join(dir, name));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of ["aya-turn-old", "aya-snapshot-x.index", "unrelated"]) utimesSync(join(dir, name), old, old);
    await sweepSnapshotTemp(dir);
    assert.deepEqual(readdirSync(dir).sort(), ["aya-turn-new", "unrelated"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a slow repository does not hold a send past the wait, and is skipped once it was slow twice", async () => {
  const { dir, done } = repo();
  const bin = mkdtempSync(join(tmpdir(), "aya-slow-git-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" add -A "*) sleep 1.3;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const diffs = new GuiTurnDiffs();
    let started = Date.now();
    assert.equal(await diffs.beginTurn("pane", dir), null, "the send goes on without the snapshot");
    assert.ok(Date.now() - started < SEND_WAIT_MS + 500, `waited ${Date.now() - started} ms`);
    const late = await diffs.currentStart("pane");
    assert.ok(late?.tree, "the late snapshot still becomes the turn's start");
    diffs.forget("pane");
    assert.equal(await diffs.beginTurn("pane", dir), null);
    assert.ok((await diffs.currentStart("pane"))?.tree);
    diffs.forget("pane");
    started = Date.now();
    assert.equal(await diffs.snapshotNow(dir, 5000), null, "slow twice: skipped");
    assert.ok(Date.now() - started < 1000);
  } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); done(); }
});

test("a turn cut short is forgotten, so the next turn starts from a fresh snapshot", async () => {
  const { dir, done } = repo();
  try {
    const diffs = new GuiTurnDiffs(), events = [];
    const first = await diffs.beginTurn("pane", dir);
    diffs.forget("pane");
    writeFileSync(join(dir, "a.txt"), "between turns\n");
    const second = await diffs.beginTurn("pane", dir);
    assert.notEqual(second.tree, first.tree);
    writeFileSync(join(dir, "before.txt"), "the turn\n");
    diffs.observe("pane", dir, { method: "turn/completed", params: { turn: { id: "t" } } }, event => events.push(event));
    await waitForEvent(events);
    assert.deepEqual(events[0].params.turnDiff.files.map(f => f.path), ["before.txt"]);
  } finally { done(); }
});

test("a closed panel's connection end tells the turn diffs to forget it", () => {
  const ended = [];
  const state = new GuiPanelState(async () => {}, () => {}, key => ended.push(key));
  state.sessions.set("1:p", { session: { close() {} } });
  state.disconnect("1:p");
  assert.deepEqual(ended, ["1:p"]);
});

test("a turn that changed many files lists the first ones with totals for all", async () => {
  const { dir, done } = repo();
  try {
    const diffs = new GuiTurnDiffs(), events = [];
    await diffs.beginTurn("pane", dir);
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < MAX_TURN_DIFF_FILES + 5; i++) writeFileSync(join(dir, "many", `f${String(i).padStart(3, "0")}.txt`), "x\ny\n");
    diffs.observe("pane", dir, { method: "turn/completed", params: { turn: { id: "t" } } }, event => events.push(event));
    await waitForEvent(events);
    const { turnDiff } = events[0].params;
    assert.equal(turnDiff.files.length, MAX_TURN_DIFF_FILES);
    assert.deepEqual(turnDiff.totals, { files: MAX_TURN_DIFF_FILES + 5, additions: 2 * (MAX_TURN_DIFF_FILES + 5), deletions: 0 });
    assert.equal(turnDiffSummaryText(turnDiff.files, turnDiff.totals), `${MAX_TURN_DIFF_FILES + 5} files changed · +${2 * (MAX_TURN_DIFF_FILES + 5)} −0`);
  } finally { done(); }
});

test("a turn that changed files too large to snapshot names them in its summary", async () => {
  const { dir, done } = repo();
  try {
    const big = (name, byte) => writeFileSync(join(dir, name), Buffer.alloc(SNAPSHOT_FILE_LIMIT + 1, byte));
    big("same.db", 1); big("gone.log", 2); big("edited.sqlite3", 3);
    const diffs = new GuiTurnDiffs(), events = [];
    await diffs.beginTurn("pane", dir);
    big("new.bin", 4);
    rmSync(join(dir, "gone.log"));
    writeFileSync(join(dir, "edited.sqlite3"), Buffer.alloc(SNAPSHOT_FILE_LIMIT + 9, 5));
    diffs.observe("pane", dir, { method: "turn/completed", params: { turn: { id: "t" } } }, event => events.push(event));
    await waitForEvent(events);
    const { turnDiff } = events[0].params;
    assert.deepEqual(turnDiff.files, [], "nothing small changed, and the turn is still reported");
    assert.deepEqual(turnDiff.largeFiles, { count: 3, paths: ["edited.sqlite3", "gone.log", "new.bin"] });
    assert.equal(largeFilesText(turnDiff.largeFiles, 2), "3 large files changed (not shown): edited.sqlite3, gone.log, and 1 more");
  } finally { done(); }
});

test("large-file changes compare size and modification time, and cap the names", () => {
  const f = (path, size = 9, mtimeMs = 1) => ({ path, size, mtimeMs });
  assert.equal(largeFilesChanged([f("a")], [f("a")]), undefined);
  assert.deepEqual(largeFilesChanged([f("a")], [f("a", 9, 2)]), { count: 1, paths: ["a"] });
  assert.deepEqual(largeFilesChanged(undefined, [f("b", 10)]), { count: 1, paths: ["b"] });
  const many = Array.from({ length: MAX_LARGE_NAMES + 3 }, (_, i) => f(`f${String(i).padStart(2, "0")}`));
  assert.deepEqual(largeFilesChanged([], many), { count: MAX_LARGE_NAMES + 3, paths: many.slice(0, MAX_LARGE_NAMES).map(x => x.path) });
});

/** A git whose `add -A` takes 2 s and then leaves a marker, as a late snapshot writing into the repository would. */
function lateGit() {
  const bin = mkdtempSync(join(tmpdir(), "aya-late-git-")), temp = mkdtempSync(join(tmpdir(), "aya-late-tmp-"));
  const marker = join(bin, "wrote-after-close");
  const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" add -A "*) sleep 2; touch '${marker}';; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
  process.env.PATH = `${bin}:${saved.PATH}`; process.env.TMPDIR = temp;
  return {
    marker, temp,
    restore: () => { process.env.PATH = saved.PATH; if (saved.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.TMPDIR; rmSync(bin, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true }); },
  };
}
const until = async (check, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (check()) return true; return check(); };

test("closing a pane kills its snapshot in progress and removes the temp index", async () => {
  const { dir, done } = repo();
  const late = lateGit();
  try {
    const diffs = new GuiTurnDiffs();
    const pending = diffs.beginTurn("pane", dir);
    assert.ok(await until(() => readdirSync(late.temp).some(n => n.startsWith("aya-turn-"))), "the snapshot started");
    await new Promise(r => setTimeout(r, 200));
    diffs.forget("pane");
    assert.equal(await pending, null);
    assert.ok(await until(() => readdirSync(late.temp).length === 0), "the temp index is gone");
    await new Promise(r => setTimeout(r, 2300));
    assert.equal(existsSync(late.marker), false, "the killed git never wrote");
  } finally { late.restore(); done(); }
});

test("quitting kills every snapshot git at once and removes their temp folders synchronously", async () => {
  const { dir, done } = repo();
  const late = lateGit();
  try {
    const pending = new GuiTurnDiffs().snapshotNow(dir, 5000);
    assert.ok(await until(() => readdirSync(late.temp).some(n => n.startsWith("aya-turn-"))));
    await new Promise(r => setTimeout(r, 200));
    stopAllSnapshots();
    assert.deepEqual(readdirSync(late.temp), [], "removed before the exit handler returns");
    assert.equal(await pending, null);
    await new Promise(r => setTimeout(r, 2300));
    assert.equal(existsSync(late.marker), false);
  } finally { late.restore(); done(); }
});
