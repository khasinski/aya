// getGitHubLink and isGitHubCliAvailable against a fake `gh` first on PATH and a
// real local git repo: which gh commands run, in which directory, with the update
// notifier off, and what a branch, a detached HEAD or a missing gh resolve to.
// github.test.mjs covers the choice between PR and branch with injected effects;
// this file covers the effects. Nothing reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-gh-")));
const bin = join(root, "bin");
const state = join(root, "state");
mkdirSync(bin);
mkdirSync(state);
const LOG = join(state, "calls.log");
// One line per call: the directory, the notifier variable, the arguments. The paths come in
// through the environment (copied by the module at load, below), never as shell source.
process.env.FAKE_GH_STATE = state;
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
printf '%s|%s|%s\\n' "$PWD" "$GH_NO_UPDATE_NOTIFIER" "$*" >> "$FAKE_GH_STATE/calls.log"
case "$1" in
  --version) [ -e "$FAKE_GH_STATE/broken" ] && exit 1; echo "gh version 9.9.9"; exit 0 ;;
  pr) [ -e "$FAKE_GH_STATE/pr" ] && { cat "$FAKE_GH_STATE/pr"; exit 0; }; echo "no pull requests found" >&2; exit 1 ;;
  browse) [ -e "$FAKE_GH_STATE/no-remote" ] && exit 1; echo "https://github.com/acme/repo/tree/$4"; exit 0 ;;
esac
exit 2
`,
);
chmodSync(join(bin, "gh"), 0o755);
// The module copies the environment when it loads, so PATH must name the fake gh first.
process.env.PATH = `${bin}:${process.env.PATH}`;
const { getGitHubLink, isGitHubCliAvailable } = await import("../dist-electron/github.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

function repo(branch) {
  const dir = realpathSync(mkdtempSync(join(root, "repo-")));
  // None of the user's or the system's git config, hooks or templates.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, stdio: "ignore" });
  git("init", "-q", "--template=", "-b", branch);
  git("commit", "-q", "--allow-empty", "-m", "first");
  return { dir, git };
}

function calls() {
  if (!existsSync(LOG)) return [];
  const lines = readFileSync(LOG, "utf8").trim().split("\n");
  rmSync(LOG);
  return lines.map((l) => {
    const [cwd, notifier, args] = l.split("|");
    return { cwd, notifier, args };
  });
}

function setState(name, content) {
  const file = join(state, name);
  if (content === undefined) rmSync(file, { force: true });
  else writeFileSync(file, content);
}

test("no PR: the branch page, from gh browse run in the project with the update notifier off", async () => {
  const { dir } = repo("feature/x");
  calls();
  assert.deepEqual(await getGitHubLink(dir), { kind: "branch", url: "https://github.com/acme/repo/tree/feature/x" });
  assert.deepEqual(calls(), [
    { cwd: dir, notifier: "1", args: "pr view --json url --jq .url" },
    { cwd: dir, notifier: "1", args: "browse --no-browser --branch feature/x" },
  ]);
});

test("a PR: its url, and gh browse is not asked", async () => {
  const { dir } = repo("main");
  setState("pr", "https://github.com/acme/repo/pull/7\n");
  try {
    calls();
    assert.deepEqual(await getGitHubLink(dir), { kind: "pr", url: "https://github.com/acme/repo/pull/7" });
    assert.deepEqual(calls().map((c) => c.args), ["pr view --json url --jq .url"]);
  } finally {
    setState("pr");
  }
});

test("a detached HEAD has no branch page: null, without asking gh browse", async () => {
  const { dir, git } = repo("main");
  git("checkout", "-q", "--detach");
  calls();
  assert.equal(await getGitHubLink(dir), null);
  assert.deepEqual(calls().map((c) => c.args), ["pr view --json url --jq .url"]);
});

test("not a git repo, or no GitHub remote: null", async () => {
  const plain = mkdtempSync(join(root, "plain-"));
  assert.equal(await getGitHubLink(plain), null);
  const { dir } = repo("main");
  setState("no-remote", "");
  try {
    assert.equal(await getGitHubLink(dir), null);
  } finally {
    setState("no-remote");
  }
  calls();
});

test("isGitHubCliAvailable: yes when gh --version works, no when it fails", async () => {
  calls();
  assert.equal(await isGitHubCliAvailable(), true);
  setState("broken", "");
  try {
    assert.equal(await isGitHubCliAvailable(), false);
  } finally {
    setState("broken");
  }
  assert.deepEqual(calls().map((c) => [c.args, c.notifier]), [["--version", "1"], ["--version", "1"]]);
});
