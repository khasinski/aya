import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hydrateProjectActiveTabs,
  hydrateProjectTerminalStates,
} from "../dist-test/project-persistence.js";

const tab = (id, extra = {}) => ({ id, presetId: "claude", name: "Claude", ...extra });
const project = (tabs, extra = {}) => ({
  slug: "aya", name: "Aya", directory: "/repo/aya", tabs, ...extra,
});

test("hydration restores saved tabs in order without changing other projects", () => {
  const other = { id: "other", projectSlug: "other", status: "waiting" };
  const prev = { other };
  const saved = project([tab("a"), tab("b", { presetId: "shell", name: "Shell" })]);
  const next = hydrateProjectTerminalStates(prev, saved, "/home/fallback");
  assert.deepEqual(Object.keys(next), ["other", "a", "b"]);
  assert.equal(next.other, other);
  assert.deepEqual(next.a, {
    id: "a", projectSlug: "aya", presetId: "claude", name: "Claude",
    cwd: "/home/fallback", status: "running", bell: false, exitCode: null, restored: true,
  });
  assert.deepEqual(next.b, { ...next.a, id: "b", presetId: "shell", name: "Shell" });
  assert.deepEqual(prev, { other });
  assert.deepEqual(saved.tabs, [tab("a"), tab("b", { presetId: "shell", name: "Shell" })]);
});

test("hydration keeps worktree cwd and saved session, sharing, team and ssh fields", () => {
  const next = hydrateProjectTerminalStates({}, project([tab("a", {
    cwd: "/repo/worktree", sessionId: "session", sharedDir: true,
    teamLaunch: true, sshTarget: "dev@machine",
  })]), "/repo/aya");
  assert.deepEqual(next.a, {
    id: "a", projectSlug: "aya", presetId: "claude", name: "Claude",
    cwd: "/repo/worktree", status: "running", bell: false, exitCode: null, restored: true,
    sessionId: "session", sharedDir: true, teamLaunch: true, sshTarget: "dev@machine",
  });
});

test("remote hydration uses the supplied remote directory while honoring tab cwd", () => {
  const saved = project([tab("a"), tab("b", { cwd: "/srv/worktree" })], {
    remote: { hostId: "host", label: "Host", sshTarget: "host", directory: "/srv/aya" },
  });
  const next = hydrateProjectTerminalStates({}, saved, saved.remote.directory);
  assert.equal(next.a.cwd, "/srv/aya");
  assert.equal(next.b.cwd, "/srv/worktree");
});

test("hydration preserves empty cwd and omits false or empty optional fields", () => {
  const next = hydrateProjectTerminalStates({}, project([tab("a", {
    cwd: "", sessionId: "", sharedDir: false, teamLaunch: false, sshTarget: "",
  })]), "/fallback");
  assert.equal(next.a.cwd, "");
  for (const field of ["sessionId", "sharedDir", "teamLaunch", "sshTarget"]) {
    assert.equal(Object.hasOwn(next.a, field), false, field);
  }
});

test("hydration replaces an existing saved tab with its restored state", () => {
  const existing = { id: "a", status: "error", bell: true, exitCode: 1, spawnFailure: {} };
  const prev = { a: existing };
  const next = hydrateProjectTerminalStates(prev, project([tab("a")]), "/repo/aya");
  assert.equal(next.a.status, "running");
  assert.equal(next.a.bell, false);
  assert.equal(next.a.exitCode, null);
  assert.equal(next.a.restored, true);
  assert.equal(Object.hasOwn(next.a, "spawnFailure"), false);
  assert.equal(prev.a, existing);
  assert.equal(existing.status, "error");
});

test("hydrating a project without tabs still copies the terminal map", () => {
  const prev = { other: { id: "other" } };
  const next = hydrateProjectTerminalStates(prev, project([]), "/repo/aya");
  assert.notEqual(next, prev);
  assert.deepEqual(next, prev);
  assert.equal(next.other, prev.other);
});

test("hydration preserves a valid saved active tab even when it is not first", () => {
  const prev = { aya: "b", other: "other-tab" };
  const next = hydrateProjectActiveTabs(prev, project([tab("a"), tab("b")]));
  assert.deepEqual(next, prev);
  assert.notEqual(next, prev);
  assert.deepEqual(prev, { aya: "b", other: "other-tab" });
});

test("missing, null and stale active selections default to the first saved tab", () => {
  for (const prev of [{}, { aya: null }, { aya: "deleted" }]) {
    assert.deepEqual(hydrateProjectActiveTabs({ other: "other-tab", ...prev }, project([
      tab("a"), tab("b"),
    ])), { other: "other-tab", aya: "a" });
  }
});

test("an empty project gets a null active selection without clearing other projects", () => {
  assert.deepEqual(hydrateProjectActiveTabs({ aya: "deleted", other: "other-tab" }, project([])), {
    aya: null, other: "other-tab",
  });
});
