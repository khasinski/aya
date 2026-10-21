import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "aya-publish-")));
const bin = join(root, "bin");
const state = join(root, "state");
mkdirSync(bin); mkdirSync(state);
process.env.FAKE_GIT_REAL = realpathSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim());
process.env.FAKE_GIT_TEST_STATE = state;
process.env.FAKE_GH_STATE = state;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s|%s|%s|%s\n' "$GH_PROMPT_DISABLED" "$GH_NO_UPDATE_NOTIFIER" "$*" "$(test -t 0 && echo tty || echo pipe)" >> "$FAKE_GH_STATE/calls"
case "$1 $2" in
  "--version ") echo 'gh version test'; exit 0 ;;
  "auth status") [ -e "$FAKE_GH_STATE/unauth" ] && { echo 'You are not logged into any GitHub hosts. account=private token=secret' >&2; exit 1; }; exit 0 ;;
  "repo view")
    if [ -f "$FAKE_GH_STATE/switch-on-repo-view" ]; then git checkout -q alternate; : > "$FAKE_GH_STATE/switch-used"; fi
    echo 'https://github.com/acme/repo'; exit 0 ;;
  "pr view") [ -e "$FAKE_GH_STATE/pr" ] && { cat "$FAKE_GH_STATE/pr"; exit 0; }; echo 'no pull requests found for branch' >&2; exit 1 ;;
  "pr create") cat "$FAKE_GH_STATE/create-url"; exit 0 ;;
esac
if [ -e "$FAKE_GH_STATE/slow" ]; then sleep 1; fi
exit 2
`);
chmodSync(join(bin, "gh"), 0o755);
writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const args = process.argv.slice(2);
const state = process.env.FAKE_GIT_TEST_STATE;
if (existsSync(join(state, 'track-prompt-setting'))) {
  appendFileSync(join(state, 'git-prompt-settings'), (process.env.GIT_TERMINAL_PROMPT ?? '<unset>') + '\\n');
}
const statusHead = args[0] === 'symbolic-ref' && args[1] === '--quiet' && args[2] === '--short' && args[3] === 'HEAD';
if (statusHead) {
  appendFileSync(join(state, 'publish-status-env'), (process.env.GIT_TERMINAL_PROMPT ?? '<unset>') + '\\n');
  if (existsSync(join(state, 'hold-publish-status'))) {
    writeFileSync(join(state, 'publish-status-pid'), String(process.pid));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
}
const result = spawnSync(process.env.FAKE_GIT_REAL, args, { encoding: 'utf8', env: process.env });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`);
chmodSync(join(bin, "git"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const { getPublishStatus, pushCurrentBranch, createOrFindPullRequest, runGh } = await import("../dist-electron/git-publish.js");

test.after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore", env: process.env });
}
function repo(name = "repo") {
  const dir = realpathSync(mkdtempSync(join(root, `${name}-`)));
  git(dir, "init", "-q", "--template=");
  writeFileSync(join(dir, "file.txt"), "base\n");
  git(dir, "add", "file.txt"); git(dir, "commit", "-q", "-m", "base");
  return dir;
}
function bare(name = "remote.git") {
  const dir = join(root, name); mkdirSync(dir);
  git(root, "init", "-q", "--bare", dir);
  return dir;
}
function setState(name, value) {
  const file = join(state, name);
  if (value === null) rmSync(file, { force: true }); else writeFileSync(file, value);
}
function ghCalls() {
  const file = join(state, "calls");
  if (!existsSync(file)) return [];
  const out = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((row) => row.split("|"));
  rmSync(file);
  return out;
}

test("push remote follows explicit configuration or the only remote; ambiguous remotes refuse", async () => {
  const dir = repo("remotes");
  git(dir, "remote", "add", "origin", "https://example.invalid/origin.git");
  git(dir, "remote", "add", "backup", "https://example.invalid/backup.git");
  assert.equal((await getPublishStatus(dir)).remote, null);
  assert.match((await getPublishStatus(dir)).pushDisabledReason, /Choose a push remote/);
  git(dir, "config", "branch.main.pushRemote", "backup");
  assert.equal((await getPublishStatus(dir)).remote, "backup");
  git(dir, "config", "--unset", "branch.main.pushRemote");
  git(dir, "config", "branch.main.remote", "backup");
  assert.equal((await getPublishStatus(dir)).remote, "backup");
  git(dir, "config", "--unset", "branch.main.remote");
  git(dir, "config", "remote.pushDefault", "backup");
  assert.equal((await getPublishStatus(dir)).remote, "backup");
  git(dir, "config", "--unset", "remote.pushDefault");
  git(dir, "remote", "remove", "origin");
  git(dir, "remote", "add", "extra", "https://example.invalid/extra.git");
  assert.match((await getPublishStatus(dir)).pushDisabledReason, /Choose a push remote/);
  git(dir, "remote", "remove", "backup");
  git(dir, "remote", "remove", "extra");
  git(dir, "remote", "add", "only", "https://example.invalid/only.git");
  assert.equal((await getPublishStatus(dir)).remote, "only");
});

test("a remote name beginning with a dash cannot be used for publishing", async () => {
  const dir = repo("unsafe-remote");
  git(dir, "config", "remote.--receive-pack=./unexpected.url", "https://example.invalid/repo.git");
  const status = await getPublishStatus(dir);
  assert.equal(status.remote, null);
  assert.match(status.pushDisabledReason, /remote name that starts with '-'/);
  assert.equal((await pushCurrentBranch(dir)).ok, false);
});

test("an unfetched remote default branch keeps pull requests disabled", async () => {
  const dir = repo("unknown-default");
  git(dir, "remote", "add", "origin", "https://example.invalid/origin.git");
  const status = await getPublishStatus(dir);
  assert.equal(status.pushDisabledReason, null);
  assert.match(status.pullRequestDisabledReason, /default branch is unknown/);
});

test("missing remote disables push and pull request with one shared reason", async () => {
  const dir = repo("no-remote");
  const status = await getPublishStatus(dir);
  assert.equal(status.remote, null);
  assert.equal(status.pushDisabledReason, "Add a Git remote before pushing or opening a pull request.");
  assert.equal(status.pullRequestDisabledReason, status.pushDisabledReason);
});

test("publish status uses one deadline across sequential Git probes", async () => {
  const dir = repo("status-deadline");
  const budgets = [];
  const began = Date.now();
  const runner = async (_command, args, _cwd, timeout, env, signal) => {
    budgets.push(timeout);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return args[0] === "symbolic-ref" ? "feature/slow\n" : "origin\n";
  };
  await assert.rejects(getPublishStatus(dir, { timeoutMs: 100, runCommand: runner }), /deadline/i);
  assert.deepEqual(budgets.length, 2, "the second Git probe starts, then is cut off by the shared budget");
  assert.ok(budgets[0] <= 100 && budgets[0] > 90);
  assert.ok(budgets[1] < 50 && budgets[1] > 0, "the second probe receives only the remaining time");
  assert.ok(Date.now() - began < 250, "the total query stays within one deadline plus scheduling allowance");
});

test("publish status disables Git prompts and aborting it kills its Git child", async () => {
  const dir = repo("status-cancel");
  git(dir, "remote", "add", "origin", "https://example.invalid/origin.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const envLog = join(state, "publish-status-env");
  const promptLog = join(state, "git-prompt-settings");
  const trackPrompt = join(state, "track-prompt-setting");
  const childPidPath = join(state, "publish-status-pid");
  const hold = join(state, "hold-publish-status");
  const waitForPid = async () => {
    const until = Date.now() + 2_000;
    while (!existsSync(childPidPath) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(childPidPath), "the hanging Git child started");
    return Number(readFileSync(childPidPath, "utf8"));
  };
  const expectDead = async (pid) => {
    const until = Date.now() + 1_000;
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Git child ${pid} survived cancellation`);
  };

  rmSync(envLog, { force: true });
  rmSync(childPidPath, { force: true });
  rmSync(promptLog, { force: true });
  writeFileSync(trackPrompt, "");
  await getPublishStatus(dir);
  rmSync(trackPrompt, { force: true });
  assert.ok(readFileSync(promptLog, "utf8").trim().split("\n").every((value) => value === "0"), "every status Git call disables terminal prompts");
  assert.ok(readFileSync(envLog, "utf8").trim().split("\n").every((value) => value === "0"));

  writeFileSync(hold, "");
  rmSync(childPidPath, { force: true });
  const controller = new AbortController();
  const cancelledQuery = getPublishStatus(dir, { signal: controller.signal, timeoutMs: 2_000 });
  const cancelledPid = await waitForPid();
  controller.abort(new Error("The Changes panel closed."));
  await assert.rejects(cancelledQuery, /panel closed/);
  try { await expectDead(cancelledPid); }
  finally { rmSync(hold, { force: true }); }
});

test("detached HEAD disables push and pull request; default branch allows push but not pull request", async () => {
  const dir = repo("branch-rules");
  const remote = bare("branch-rules.git");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "--set-upstream", "origin", "HEAD");
  git(dir, "remote", "set-head", "origin", "-a");
  const normal = await getPublishStatus(dir);
  assert.equal(normal.branch, "main");
  assert.equal(normal.pushDisabledReason, null);
  assert.match(normal.pullRequestDisabledReason, /feature branch/);
  git(dir, "checkout", "-q", "-b", "feature/test");
  const feature = await getPublishStatus(dir);
  assert.equal(feature.pullRequestDisabledReason, null);
  git(dir, "checkout", "-q", "--detach");
  const detached = await getPublishStatus(dir);
  assert.match(detached.pushDisabledReason, /Create a branch/);
  assert.match(detached.pullRequestDisabledReason, /Create a branch/);
});

test("push uses Git's fast-forward rejection and never changes the branch automatically", async () => {
  const dir = repo("behind"); const remote = bare("behind.git");
  git(dir, "remote", "add", "origin", remote); git(dir, "push", "-q", "--set-upstream", "origin", "HEAD");
  const second = realpathSync(mkdtempSync(join(root, "second-")));
  git(root, "clone", "-q", remote, second);
  writeFileSync(join(second, "other.txt"), "remote\n"); git(second, "add", "other.txt"); git(second, "commit", "-q", "-m", "remote"); git(second, "push", "-q");
  writeFileSync(join(dir, "local.txt"), "local\n"); git(dir, "add", "local.txt"); git(dir, "commit", "-q", "-m", "local");
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const result = await pushCurrentBranch(dir);
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected|fetch first|non-fast-forward/i);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), before);
  assert.equal(existsSync(join(dir, "other.txt")), false);
});

test("push refuses if the checkout changes while it is resolving upstream", async () => {
  const dir = repo("push-branch-race");
  git(dir, "remote", "add", "origin", "https://example.invalid/origin.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-q", "-b", "feature/target");
  git(dir, "checkout", "-q", "-b", "alternate");
  git(dir, "checkout", "-q", "feature/target");
  const calls = [];
  let switched = false;
  const runner = async (command, args, cwd, timeout, env) => {
    if (args[0] === "rev-parse" && args.at(-1) === "@{upstream}" && !switched) {
      switched = true;
      git(dir, "checkout", "-q", "alternate");
    }
    if (args[0] === "push") calls.push(args);
    return execFileSync(command, args, { cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  };
  const result = await pushCurrentBranch(dir, runner);
  assert.equal(result.ok, false);
  assert.match(result.error, /branch changed/);
  assert.deepEqual(calls, []);
});

test("gh uses disabled prompts and pipes, hides auth details, and accepts only this repository's HTTPS PR URL", async () => {
  const dir = repo("gh-repo");
  git(dir, "checkout", "-q", "-b", "feature/gh");
  git(dir, "remote", "add", "origin", "https://github.com/acme/repo.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  ghCalls();
  setState("create-url", "https://github.com/acme/repo/pull/7\n");
  const created = await createOrFindPullRequest(dir);
  assert.deepEqual(created, { ok: true, url: "https://github.com/acme/repo/pull/7" });
  assert.deepEqual(ghCalls().map(([prompt, updates, args, tty]) => [prompt, updates, args, tty]), [
    ["1", "1", "--version", "pipe"], ["1", "1", "auth status", "pipe"],
    ["1", "1", "repo view --json url --jq .url", "pipe"],
    ["1", "1", "pr view feature/gh --json url --jq .url", "pipe"], ["1", "1", "pr create --fill --head feature/gh", "pipe"],
  ]);
  setState("unauth", "");
  try {
    const refused = await createOrFindPullRequest(dir);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /Run gh auth login/);
    assert.doesNotMatch(refused.error, /`/);
    assert.doesNotMatch(refused.error, /private|secret/);
  } finally { setState("unauth", null); }
  setState("create-url", "https://evil.example/acme/repo/pull/7\n");
  assert.match((await createOrFindPullRequest(dir)).error, /did not return a pull request link/);
});

test("an existing pull request is opened without attempting to create another", async () => {
  const dir = repo("existing-pr");
  git(dir, "checkout", "-q", "-b", "feature/existing");
  git(dir, "remote", "add", "origin", "https://github.com/acme/repo.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  setState("pr", "https://github.com/acme/repo/pull/17\n");
  ghCalls();
  try {
    assert.deepEqual(await createOrFindPullRequest(dir), { ok: true, url: "https://github.com/acme/repo/pull/17" });
    const calls = ghCalls().map(([, , args]) => args);
    assert(calls.some((args) => args.startsWith("pr view ")));
    assert.equal(calls.some((args) => args.startsWith("pr create ")), false);
  } finally { setState("pr", null); }
});

test("GitHub sign-in checks distinguish a timeout from a signed-out account", async () => {
  const dir = repo("auth-status-error");
  git(dir, "checkout", "-q", "-b", "feature/auth-status");
  git(dir, "remote", "add", "origin", "https://github.com/acme/repo.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const gitRunner = async (command, args, cwd, _timeout, env) => execFileSync(command, args, {
    cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  for (const { failure, expected, forbidden } of [
    { failure: Object.assign(new Error("request timed out"), { code: "ETIMEDOUT", stderr: "network timeout" }), expected: /did not respond in time/, forbidden: /not signed in/ },
    { failure: Object.assign(new Error("auth endpoint unavailable"), { code: 1, stderr: "account=private token=secret connection refused" }), expected: /could not check your GitHub sign-in/, forbidden: /private|secret|not signed in/ },
  ]) {
    const calls = [];
    const ghRunner = async (_directory, args) => {
      calls.push(args);
      if (args[0] === "--version") return "gh version test";
      if (args[0] === "auth") throw failure;
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    };
    const result = await createOrFindPullRequest(dir, gitRunner, ghRunner);
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.doesNotMatch(result.error, forbidden);
    assert.deepEqual(calls.map((args) => args[0]), ["--version", "auth"]);
  }
});

test("pull request action refuses if the checkout changes after repository lookup", async () => {
  const dir = repo("pr-branch-race");
  git(dir, "remote", "add", "origin", "https://github.com/acme/repo.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-q", "-b", "feature/target");
  git(dir, "checkout", "-q", "-b", "alternate");
  git(dir, "checkout", "-q", "feature/target");
  ghCalls();
  setState("switch-on-repo-view", "");
  try {
    const result = await createOrFindPullRequest(dir);
    assert.equal(result.ok, false);
    assert.match(result.error, /branch changed/);
    assert.deepEqual(ghCalls().map(([, , args]) => args), ["--version", "auth status", "repo view --json url --jq .url"]);
  } finally {
    setState("switch-on-repo-view", null);
    setState("switch-used", null);
  }
});

test("pull request view timeout never falls through to create", async () => {
  const dir = repo("pr-view-timeout");
  git(dir, "remote", "add", "origin", "https://github.com/acme/repo.git");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-q", "-b", "feature/timeout");
  const ghCalls = [];
  const gitRunner = async (command, args, cwd, _timeout, env) => execFileSync(command, args, {
    cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const ghRunner = async (_directory, args) => {
    ghCalls.push(args);
    if (args[0] === "--version" || args[0] === "auth" || args[0] === "repo") {
      return args[0] === "repo" ? "https://github.com/acme/repo" : "ok";
    }
    if (args[0] === "pr" && args[1] === "view") {
      throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT", stderr: "network timeout" });
    }
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/acme/repo/pull/8";
    throw new Error(`Unexpected gh args: ${args.join(" ")}`);
  };
  const result = await createOrFindPullRequest(dir, gitRunner, ghRunner);
  assert.deepEqual(result, { ok: false, error: "GitHub did not respond in time. Try again." });
  assert.deepEqual(ghCalls.map((args) => args.slice(0, 2)), [["--version"], ["auth", "status"], ["repo", "view"], ["pr", "view"]]);
});

test("every gh call is bounded and times out", async () => {
  const dir = repo("gh-timeout");
  setState("slow", "");
  try { await assert.rejects(runGh(dir, ["slow"], 50), (error) => error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"); }
  finally { setState("slow", null); }
});

test("push has a bounded timeout and does not force", async () => {
  const dir = repo("push-timeout");
  const remote = bare("push-timeout.git");
  git(dir, "remote", "add", "origin", remote);
  let pushCall;
  const runner = async (command, args, cwd, timeout, env) => {
    if (args[0] === "push") {
      pushCall = { command, args, timeout, env };
      throw Object.assign(new Error("push timed out"), { killed: true });
    }
    return execFileSync(command, args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  };
  const result = await pushCurrentBranch(dir, runner);
  assert.equal(result.ok, false);
  assert.equal(pushCall.timeout, 60_000);
  assert.deepEqual(pushCall.args.slice(0, 2), ["push", "--set-upstream"]);
  assert.equal(pushCall.args.includes("--force"), false);
});
