// opencode's `--continue` resumes the newest session of ANY worktree of the repo: when the session lookup fails,
// a pane of a repo with sibling worktrees must start fresh, not take the sibling's conversation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownSessionCommand } from "../dist-electron/opencode-session.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "oc-failed-")));
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

function repo(name, withSibling) {
  const main = path.join(root, name);
  mkdirSync(main);
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "root");
  const sibling = path.join(root, `${name}-wt`);
  if (withSibling) git(main, "worktree", "add", "-q", sibling, "-b", `${name}-b`);
  return { main, sibling };
}

const single = repo("single", false);
const paired = repo("paired", true);
const notARepo = realpathSync(mkdtempSync(path.join(root, "plain-")));

// siblings: whether another worktree of the repo exists, so a bare --continue may be its session.
const TOPOLOGIES = {
  "single checkout": { cwd: single.main, siblings: false },
  "main checkout with a linked worktree": { cwd: paired.main, siblings: true },
  "the linked worktree": { cwd: paired.sibling, siblings: true },
  "not a repo": { cwd: notARepo, siblings: false },
};
const COMMANDS = ["opencode --continue", "FOO=1 opencode --continue --model x"];
const withoutContinue = (command) => command.replace(" --continue", "");

for (const [name, { cwd, siblings }] of Object.entries(TOPOLOGIES)) {
  for (const command of COMMANDS) {
    test(`lookup fails, ${name}, "${command}"`, async () => {
      const errors = [];
      const out = await ownSessionCommand(command, cwd, async () => {
        throw new Error("lookup timed out");
      }, (err) => errors.push(err));
      assert.equal(errors.length, 1, "the failure is still reported");
      assert.equal(out, siblings ? withoutContinue(command) : command);
    });

    test(`lookup answers, ${name}, "${command}": the own session wins, none means fresh`, async () => {
      const own = { id: "ses_own", directory: cwd, updated: 100 };
      const other = { id: "ses_other", directory: path.join(root, "elsewhere"), updated: 300 };
      assert.match(await ownSessionCommand(command, cwd, async () => [other, own]), /--session ses_own/);
      assert.equal(await ownSessionCommand(command, cwd, async () => [other]), withoutContinue(command));
    });
  }
}

test("a command without --continue never asks git or opencode, failing or not", async () => {
  let asked = 0;
  const list = async () => {
    asked += 1;
    throw new Error("x");
  };
  assert.equal(await ownSessionCommand("opencode", paired.main, list), "opencode");
  assert.equal(asked, 0);
});

// A failed sibling check rules no sibling out, so the bare --continue goes; only "not a git repository" keeps it.
const GIT_OUTCOMES = {
  "git times out": [() => Promise.reject(Object.assign(new Error("Command failed: git worktree list: timed out"), { killed: true })), false],
  "git is missing": [() => Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })), false],
  "git says it is no repository": [() => Promise.reject(Object.assign(new Error("Command failed"), { stderr: "fatal: not a git repository (or any of the parent directories): .git\n" })), true],
  "one worktree": [async () => [{ path: single.main }], true],
  "two worktrees": [async () => [{ path: single.main }, { path: single.sibling }], false],
};
for (const [name, [worktrees, keeps]] of Object.entries(GIT_OUTCOMES)) {
  for (const command of COMMANDS) {
    test(`lookup fails, ${name}, "${command}": ${keeps ? "kept" : "dropped"}`, async () => {
      const out = await ownSessionCommand(command, single.main, async () => {
        throw new Error("lookup timed out");
      }, () => {}, () => {}, worktrees);
      assert.equal(out, keeps ? command : withoutContinue(command));
    });
  }
}
