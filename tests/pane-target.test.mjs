// Resolving which pane a pane-read / pane-send request means. This is the
// safety-critical half of the pane API: a wrong match means an agent types
// into a terminal the user never pointed it at, so ambiguity must be an error
// rather than a best guess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANE_READ_MAX_CHARS,
  resolvePaneTarget,
  tailForPaneRead,
} from "../dist-electron/pane-target.js";

const project = (slug, tabs) => ({
  slug,
  name: slug,
  directory: `/${slug}`,
  tabs: tabs.map(([id, name]) => ({ id, presetId: "claude", name })),
});

const PROJECTS = [
  project("alpha", [["t1", "build"], ["t2", "reviewer"]]),
  project("beta", [["t3", "build"], ["t4", "deploy"]]),
];

// --- by id -----------------------------------------------------------------

test("an exact terminal id resolves regardless of project scope", () => {
  const r = resolvePaneTarget(PROJECTS, { terminalId: "t4" });
  assert.equal(r.ok, true);
  assert.equal(r.match.name, "deploy");
  assert.equal(r.match.projectSlug, "beta");
});

test("an unknown id is an error, not a fallback to name matching", () => {
  const r = resolvePaneTarget(PROJECTS, { terminalId: "nope", name: "build" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no pane with id nope/);
});

// --- by name ---------------------------------------------------------------

test("a unique name resolves", () => {
  const r = resolvePaneTarget(PROJECTS, { name: "reviewer" });
  assert.equal(r.ok, true);
  assert.equal(r.match.terminalId, "t2");
});

test("name matching ignores case and surrounding whitespace", () => {
  const r = resolvePaneTarget(PROJECTS, { name: "  ReViEwEr " });
  assert.equal(r.ok, true);
  assert.equal(r.match.terminalId, "t2");
});

test("a name used in two projects is ambiguous, never silently picked", () => {
  const r = resolvePaneTarget(PROJECTS, { name: "build" });
  assert.equal(r.ok, false);
  assert.match(r.error, /ambiguous/);
  // The message must name both candidates so the caller can disambiguate.
  assert.match(r.error, /alpha\/build/);
  assert.match(r.error, /beta\/build/);
});

test("the caller's project disambiguates a shared name", () => {
  const r = resolvePaneTarget(PROJECTS, { name: "build", projectSlug: "beta" });
  assert.equal(r.ok, true);
  assert.equal(r.match.terminalId, "t3");
});

test("a name absent from the scoped project does not leak in from another", () => {
  const r = resolvePaneTarget(PROJECTS, { name: "deploy", projectSlug: "alpha" });
  assert.equal(r.ok, false);
  assert.match(r.error, /no pane named "deploy"/);
});

test("neither name nor id is an error", () => {
  const r = resolvePaneTarget(PROJECTS, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /required/);
});

test("an empty project list resolves nothing", () => {
  assert.equal(resolvePaneTarget([], { name: "build" }).ok, false);
});

// --- read tail -------------------------------------------------------------

test("a short buffer is returned whole", () => {
  assert.equal(tailForPaneRead("hello"), "hello");
});

test("a long buffer is trimmed to its most recent slice", () => {
  const buffer = "a".repeat(100) + "TAIL";
  const out = tailForPaneRead(buffer, 10);
  assert.equal(out.length, 10);
  assert.ok(out.endsWith("TAIL"), "must keep the END, not the start");
});

test("the default cap is applied when no size is passed", () => {
  const out = tailForPaneRead("x".repeat(PANE_READ_MAX_CHARS + 500));
  assert.equal(out.length, PANE_READ_MAX_CHARS);
});
