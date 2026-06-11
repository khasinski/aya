// Conflict semantics for hot-reloading externally-edited project configs (#4).
// Each test encodes one maintainer decision from the issue; the overarching
// rule is "editing a file must never unexpectedly kill running terminals".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeProjectsFromDisk,
  terminalsForNewTabs,
  withTabUpdatesFromDisk,
} from "../dist-test/project-reload.js";

function project(slug, overrides = {}) {
  return {
    slug,
    name: slug,
    directory: `/tmp/${slug}`,
    tabs: [{ id: `${slug}-tab1`, presetId: "shell", name: "shell 1" }],
    ...overrides,
  };
}

function termState(id, slug, overrides = {}) {
  return {
    id,
    projectSlug: slug,
    presetId: "shell",
    name: id,
    cwd: `/tmp/${slug}`,
    status: "running",
    bell: false,
    exitCode: null,
    ...overrides,
  };
}

// --- mergeProjectsFromDisk ---------------------------------------------------

test("disk wins for projects it contains (name/directory/tabs replaced)", () => {
  const disk = [project("a", { name: "renamed", directory: "/new" })];
  const current = [project("a")];
  const merged = mergeProjectsFromDisk(disk, current, new Set(["a"]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, "renamed");
  assert.equal(merged[0].directory, "/new");
});

test("an OPEN project deleted on disk survives as unsaved (decision 4)", () => {
  const merged = mergeProjectsFromDisk([], [project("a")], new Set(["a"]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].slug, "a");
});

test("a CLOSED project deleted on disk drops off the list (decision 4)", () => {
  const merged = mergeProjectsFromDisk([], [project("a")], new Set());
  assert.equal(merged.length, 0);
});

test("a project added on disk appears; disk order kept, survivors appended", () => {
  const disk = [project("b"), project("c")];
  const current = [project("a"), project("b")];
  const merged = mergeProjectsFromDisk(disk, current, new Set(["a", "b"]));
  assert.deepEqual(
    merged.map((p) => p.slug),
    ["b", "c", "a"],
  );
});

// --- terminalsForNewTabs -----------------------------------------------------

test("externally-added tab gets a TerminalState without a PTY (idle, decision 2)", () => {
  const p = project("a", {
    tabs: [
      { id: "a-tab1", presetId: "shell", name: "shell 1" },
      { id: "a-tab2", presetId: "claude", name: "added outside" },
    ],
  });
  const existing = { "a-tab1": termState("a-tab1", "a") };
  const created = terminalsForNewTabs(p, existing);
  assert.equal(created.length, 1);
  assert.equal(created[0].id, "a-tab2");
  assert.equal(created[0].status, "idle");
  assert.equal(created[0].presetId, "claude");
  assert.equal(created[0].cwd, "/tmp/a");
  // spawnDeferred keeps the tab out of the hidden TerminalView pool, which is
  // what would otherwise mount an xterm and spawn the PTY immediately.
  assert.equal(created[0].spawnDeferred, true);
});

test("existing terminals are never recreated (no respawn, decision 1)", () => {
  const p = project("a");
  const existing = { "a-tab1": termState("a-tab1", "a", { status: "error" }) };
  assert.equal(terminalsForNewTabs(p, existing).length, 0);
});

// --- withTabUpdatesFromDisk --------------------------------------------------

test("external tab rename reaches the live terminal; status/cwd untouched", () => {
  const p = project("a", {
    directory: "/elsewhere",
    tabs: [{ id: "a-tab1", presetId: "shell", name: "renamed tab" }],
  });
  const existing = {
    "a-tab1": termState("a-tab1", "a", { status: "running", cwd: "/tmp/a" }),
  };
  const next = withTabUpdatesFromDisk(existing, p);
  assert.equal(next["a-tab1"].name, "renamed tab");
  assert.equal(next["a-tab1"].status, "running");
  // decision 3: a directory change applies to future terminals only
  assert.equal(next["a-tab1"].cwd, "/tmp/a");
});

test("no changes -> same reference back (React can skip the re-render)", () => {
  const p = project("a");
  const existing = {
    "a-tab1": termState("a-tab1", "a", { name: "shell 1" }),
  };
  assert.equal(withTabUpdatesFromDisk(existing, p), existing);
});

test("a tab belonging to another project's terminal id is not touched", () => {
  const p = project("a", {
    tabs: [{ id: "shared-id", presetId: "shell", name: "from a" }],
  });
  const existing = { "shared-id": termState("shared-id", "b") };
  assert.equal(withTabUpdatesFromDisk(existing, p), existing);
});
