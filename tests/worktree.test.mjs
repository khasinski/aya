// Per-terminal worktree binding helpers. These decide what gets persisted for a
// tab: a worktree cwd must survive a persist, but a plain main-dir tab must NOT
// carry a redundant cwd (else it would pin the old path if the project moves).

import { test } from "node:test";
import assert from "node:assert/strict";
import { projectBaseCwd, tabFromTerminal } from "../dist-test/worktree.js";

const term = (over) => ({
  id: "t1",
  projectSlug: "p",
  presetId: "claude",
  name: "Claude",
  cwd: "/home/me/repo",
  status: "running",
  bell: false,
  exitCode: null,
  ...over,
});

const project = (over) => ({
  slug: "p",
  name: "repo",
  directory: "/home/me/repo",
  tabs: [],
  ...over,
});

test("projectBaseCwd is the project directory locally, the remote dir for remotes", () => {
  assert.equal(projectBaseCwd(project()), "/home/me/repo");
  assert.equal(
    projectBaseCwd(
      project({
        directory: "/home/me/repo",
        remote: {
          hostId: "h",
          label: "h",
          sshTarget: "h",
          directory: "/srv/repo",
        },
      }),
    ),
    "/srv/repo",
  );
});

test("tabFromTerminal keeps a worktree cwd (differs from the base)", () => {
  const tab = tabFromTerminal(
    term({ cwd: "/home/me/repo-feature" }),
    "/home/me/repo",
  );
  assert.deepEqual(tab, {
    id: "t1",
    presetId: "claude",
    name: "Claude",
    cwd: "/home/me/repo-feature",
  });
});

test("tabFromTerminal omits cwd for a main-dir tab (equal to the base)", () => {
  const tab = tabFromTerminal(term({ cwd: "/home/me/repo" }), "/home/me/repo");
  assert.equal(Object.prototype.hasOwnProperty.call(tab, "cwd"), false);
  assert.deepEqual(tab, { id: "t1", presetId: "claude", name: "Claude" });
});

test("tabFromTerminal omits cwd when the terminal has none", () => {
  const tab = tabFromTerminal(term({ cwd: "" }), "/home/me/repo");
  assert.equal(Object.prototype.hasOwnProperty.call(tab, "cwd"), false);
});

test("round-trip: a worktree binding survives terminal -> tab", () => {
  const p = project();
  const t = term({ cwd: "/home/me/repo-wt/feature" });
  const tab = tabFromTerminal(t, projectBaseCwd(p));
  assert.equal(tab.cwd, "/home/me/repo-wt/feature");
});

test("tabFromTerminal carries the agent session id to disk", () => {
  const tab = tabFromTerminal(
    { id: "t1", presetId: "claude", name: "Claude", cwd: "/p", sessionId: "abc123" },
    "/p",
  );
  assert.equal(tab.sessionId, "abc123");
});

test("tabFromTerminal omits sessionId when the agent never reported one", () => {
  const tab = tabFromTerminal(
    { id: "t1", presetId: "claude", name: "Claude", cwd: "/p" },
    "/p",
  );
  assert.equal("sessionId" in tab, false);
});
