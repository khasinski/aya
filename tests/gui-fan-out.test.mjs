// "Send to several agents": worktree naming and planning in the renderer, and
// the main-process worktree creation / diff against throwaway repos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeRepo } from "./helpers/git.mjs";

const { diffFileCount, diffStatsText, fanOutSlug, planFanOut, fanOutSummary, slugify, queueFanOutMessage, takeFanOutMessage, recordFanOutRun, fanOutRunForTerminal } =
  await import("../dist-test/gui-fan-out.js");
const { createFanOutWorktrees, fanOutDiff } = await import("../dist-electron/gui-fan-out.js");

test("fanOutSlug keeps the prompt's first words, git-safe and short", () => {
  assert.equal(fanOutSlug("Fix the login bug, please!"), "fix-the-login-bug-please");
  assert.equal(fanOutSlug("  Ünïcode ☃ only  "), "n-code-only");
  assert.equal(fanOutSlug("Refactor the extremely long module name thing"), "refactor-the-extremely");
  assert.equal(fanOutSlug("☃☃"), "fan-out");
  assert.equal(slugify("--A  b--"), "a-b");
});

test("planFanOut names each worktree <slug>-<preset> and numbers repeats", () => {
  const presets = [
    { id: "claude", name: "Claude Opus" },
    { id: "codex", name: "Codex" },
    { id: "codex-2", name: "Codex" },
    { id: "pi", name: "☃" },
  ];
  assert.deepEqual(planFanOut("Fix Bug", presets).map((p) => p.name), [
    "fix-bug-claude-opus",
    "fix-bug-codex",
    "fix-bug-codex-2",
    "fix-bug-pi",
  ]);
  assert.equal(planFanOut("", [presets[1]])[0].name, "fan-out-codex");
  assert.equal(planFanOut("x", presets)[0].preset, presets[0]);
});

test("fanOutSummary says how many started and how many failed", () => {
  assert.equal(fanOutSummary([{ ok: true }, { ok: true }]), "Started 2 agents.");
  assert.equal(fanOutSummary([{ ok: true }, { ok: false }]), "Started 1 agent. 1 agent could not get a worktree.");
  assert.equal(fanOutSummary([{ ok: false }]), "No agent started: 1 agent could not get a worktree.");
});

test("a queued fan-out message is taken exactly once, and runs are found by pane", () => {
  queueFanOutMessage("pane-1", { text: "hi", attachments: null });
  assert.deepEqual(takeFanOutMessage("pane-1"), { text: "hi", attachments: null });
  assert.equal(takeFanOutMessage("pane-1"), null);
  recordFanOutRun({ id: "run", projectSlug: "p", projectDir: "/r", base: "a".repeat(40), baseLabel: "main", branches: [{ terminalId: "pane-2", label: "Codex", branch: "aya/x-codex", path: "/r.worktrees/x-codex" }] });
  assert.equal(fanOutRunForTerminal("pane-2")?.id, "run");
  assert.equal(fanOutRunForTerminal("pane-3"), null);
});

function repoWithCommit() {
  const dir = makeRepo("aya-fan-out-");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execSync("git init -q -b main && git config user.email t@e && git config user.name t && git config commit.gpgsign false", { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "one\n");
  execSync("git add a.txt && git commit -qm init", { cwd: repo });
  return { dir, repo: realpathSync(repo) };
}

test("createFanOutWorktrees makes one aya/<name> branch per agent from one base", async () => {
  const { dir, repo } = repoWithCommit();
  try {
    const base = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
    const result = await createFanOutWorktrees({ directory: repo, base: "main", names: ["fix-claude", "fix-codex"] });
    assert.equal(result.base, base);
    assert.deepEqual(result.results.map((r) => r.ok && r.branch), ["aya/fix-claude", "aya/fix-codex"]);
    for (const r of result.results) {
      assert.equal(r.path, join(dirname(repo), "repo.worktrees", r.name));
      assert.equal(execSync("git rev-parse HEAD", { cwd: r.path }).toString().trim(), base);
    }
    // A second run with the same names gets the next free suffix instead of failing.
    const again = await createFanOutWorktrees({ directory: repo, base: "main", names: ["fix-claude"] });
    assert.equal(again.results[0].branch, "aya/fix-claude-2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one refused worktree does not block the other agents", async () => {
  const { dir, repo } = repoWithCommit();
  try {
    // A plain file where the checkout should go makes git refuse that one.
    mkdirSync(join(dirname(repo), "repo.worktrees"), { recursive: true });
    writeFileSync(join(dirname(repo), "repo.worktrees", "t-claude"), "in the way");
    const result = await createFanOutWorktrees({ directory: repo, base: "main", names: ["t-claude", "t-codex"] });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /\S/);
    assert.equal(result.results[1].ok, true);
    assert.equal(result.results[1].branch, "aya/t-codex");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("createFanOutWorktrees refuses bad input before touching git", async () => {
  const { dir, repo } = repoWithCommit();
  try {
    assert.match((await createFanOutWorktrees({ directory: repo, base: "nope", names: ["a"] })).error, /starting ref/);
    assert.match((await createFanOutWorktrees({ directory: repo, base: "main", names: ["../x"] })).error, /not a valid/);
    assert.match((await createFanOutWorktrees({ directory: repo, base: "main", names: [] })).error, /Choose between/);
    assert.match((await createFanOutWorktrees({ directory: repo, base: "main", names: Array(7).fill("a") })).error, /Choose between/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fanOutDiff shows committed, uncommitted and untracked changes since the base", async () => {
  const { dir, repo } = repoWithCommit();
  try {
    const { base, results: [wt] } = await createFanOutWorktrees({ directory: repo, base: "main", names: ["d-codex"] });
    writeFileSync(join(wt.path, "a.txt"), "one\ncommitted\n");
    execSync("git -c user.email=t@e -c user.name=t commit -qam change", { cwd: wt.path });
    writeFileSync(join(wt.path, "a.txt"), "one\ncommitted\nuncommitted\n");
    writeFileSync(join(wt.path, "new.txt"), "untracked\n");
    const diff = await fanOutDiff(wt.path, base);
    assert.match(diff, /\+committed/);
    assert.match(diff, /\+uncommitted/);
    assert.match(diff, /new\.txt/);
    await assert.rejects(() => fanOutDiff(wt.path, "HEAD; rm -rf /"), /base commit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a compare tab counts a branch's changed files once, from the diff's headers", () => {
  const diff = "diff --git a/a b/a\n--- a/a\n+++ b/a\n+x\ndiff --git a/b b/b\n+ text mentioning diff --git inline\n";
  assert.equal(diffFileCount(diff), 2);
  assert.equal(diffFileCount(""), 0);
  assert.equal(diffStatsText(diffFileCount(diff)), "2 files");
  assert.equal(diffStatsText(1), "1 file");
  assert.equal(diffStatsText(0), "no changes");
  assert.equal(diffStatsText(null), "…");
  assert.equal(diffStatsText(undefined), "…");
});
