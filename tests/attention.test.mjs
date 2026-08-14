// Triage shared by the status rail and the attention-center modal. If these
// two ever disagreed, a terminal could show a badge in one surface and nothing
// in the other — so the classifier lives in one place and is pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionFor,
  attentionRows,
  isActionableLevel,
} from "../dist-test/attention.js";

const project = (over = {}) => ({
  slug: "demo",
  name: "Demo",
  directory: "/demo",
  tabs: [],
  ...over,
});

const termState = (id, over = {}) => ({
  id,
  projectSlug: "demo",
  presetId: "claude",
  name: id,
  cwd: "/demo",
  status: "running",
  bell: false,
  exitCode: null,
  ...over,
});

// --- level classification --------------------------------------------------

test("a spawn failure classifies as error with its detail", () => {
  const row = attentionFor(
    project(),
    termState("t1", {
      spawnFailure: { reason: "command-not-found", detail: "claude" },
    }),
  );
  assert.equal(row.level, "error");
  assert.equal(row.detail, "claude");
});

test("error outranks waiting when both could apply", () => {
  const row = attentionFor(
    project(),
    termState("t1", { status: "error", bell: true }),
  );
  assert.equal(row.level, "error");
});

test("a rung bell classifies as waiting", () => {
  const row = attentionFor(project(), termState("t1", { bell: true }));
  assert.equal(row.level, "waiting");
  assert.equal(row.detail, "Approval or input needed");
});

test("an agent-reported waiting text is preferred over the generic detail", () => {
  const row = attentionFor(
    project(),
    termState("t1", {
      bell: true,
      externalStatus: { level: "waiting", text: "Needs approval", updatedAt: 1 },
    }),
  );
  assert.equal(row.detail, "Needs approval");
});

test("a cleanly-exited agent terminal classifies as done", () => {
  const row = attentionFor(
    project(),
    termState("t1", { status: "idle", exitCode: 0 }),
  );
  assert.equal(row.level, "done");
});

test("a plain shell sitting idle is idle, never done", () => {
  const row = attentionFor(
    project(),
    termState("t1", { presetId: "shell", status: "idle", exitCode: 0 }),
  );
  assert.equal(row.level, "idle");
});

test("a busy running terminal wants no attention at all", () => {
  assert.equal(attentionFor(project(), termState("t1")), null);
});

test("a stopped terminal explains how to restart it", () => {
  const row = attentionFor(project(), termState("t1", { stopped: true }));
  assert.equal(row.level, "idle");
  assert.match(row.detail, /Shift\+Enter/);
});

// --- aggregation across projects -------------------------------------------

test("rows span every project and rank most-urgent first", () => {
  const projects = [
    project({ slug: "a", name: "Alpha" }),
    project({ slug: "b", name: "Beta" }),
  ];
  const terminals = {
    t1: termState("t1", { projectSlug: "a", status: "idle", exitCode: 0 }),
    t2: termState("t2", { projectSlug: "b", bell: true }),
    t3: termState("t3", { projectSlug: "a", status: "error" }),
  };
  const rows = attentionRows(projects, terminals);
  assert.deepEqual(
    rows.map((r) => r.level),
    ["error", "waiting", "done"],
  );
});

test("a terminal whose project is closed is dropped, not crashed on", () => {
  const rows = attentionRows(
    [project({ slug: "a", name: "Alpha" })],
    { t1: termState("t1", { projectSlug: "gone", bell: true }) },
  );
  assert.deepEqual(rows, []);
});

test("ties break on project name so the list doesn't reshuffle", () => {
  const projects = [
    project({ slug: "z", name: "Zulu" }),
    project({ slug: "a", name: "Alpha" }),
  ];
  const terminals = {
    t1: termState("t1", { projectSlug: "z", bell: true }),
    t2: termState("t2", { projectSlug: "a", bell: true }),
  };
  const rows = attentionRows(projects, terminals);
  assert.deepEqual(
    rows.map((r) => r.project.name),
    ["Alpha", "Zulu"],
  );
});

// --- actionable subset -----------------------------------------------------

test("only blocked/broken states are worth interrupting for", () => {
  assert.equal(isActionableLevel("error"), true);
  assert.equal(isActionableLevel("waiting"), true);
  assert.equal(isActionableLevel("done"), false);
  assert.equal(isActionableLevel("idle"), false);
});
