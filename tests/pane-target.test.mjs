// Resolving which pane a pane-read / pane-send request means. A wrong match has
// an agent typing into a terminal nobody pointed it at, so ambiguity is an
// error rather than a best guess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANE_READ_MAX_CHARS,
  formatPaneList,
  listPanes,
  resolvePaneTarget,
  tailForPaneRead,
} from "../dist-electron/pane-target.js";

const project = (slug, tabs) => ({
  slug,
  name: slug,
  directory: `/${slug}`,
  tabs: tabs.map(([id, name, presetId]) => ({
    id,
    presetId: presetId ?? "claude",
    name,
  })),
});

const PROJECTS = [
  project("alpha", [["t1", "build"], ["t2", "reviewer"]]),
  project("beta", [["t3", "build"], ["t4", "deploy"]]),
];

// --- by id -----------------------------------------------------------------

test("an unscoped terminal id resolves across every project", () => {
  const r = resolvePaneTarget(PROJECTS, { terminalId: "t4" });
  assert.equal(r.ok, true);
  assert.equal(r.match.name, "deploy");
  assert.equal(r.match.projectSlug, "beta");
});

test("a scoped id is looked up inside that project only", () => {
  // The shipped shape: control.ts always fills projectSlug from the CLI's
  // AYA_PROJECT_SLUG. The scope applies to ids too.
  const inScope = resolvePaneTarget(PROJECTS, {
    terminalId: "t2",
    projectSlug: "alpha",
  });
  assert.equal(inScope.ok, true);
  assert.equal(inScope.match.name, "reviewer");

  const crossProject = resolvePaneTarget(PROJECTS, {
    terminalId: "t4",
    projectSlug: "alpha",
  });
  assert.equal(crossProject.ok, false);
  assert.match(crossProject.error, /no pane with id t4/);
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
  const r = resolvePaneTarget([], { name: "build" });
  assert.equal(r.ok, false);
  // The REASON, not just the discriminant: "nothing configured" and "no name or
  // id given" are different failures that ok:false cannot tell apart.
  assert.match(r.error, /no pane named "build"/);
});

// --- listing panes ---------------------------------------------------------

test("listPanes scoped to a project returns only that project's panes", () => {
  const entries = listPanes(PROJECTS, { projectSlug: "alpha" });
  assert.deepEqual(
    entries.map((e) => e.name),
    ["build", "reviewer"],
  );
  assert.ok(entries.every((e) => e.projectSlug === "alpha"));
});

test("listPanes across all projects enumerates each one exactly once", () => {
  // Identity, not arity: emitting the first project's panes twice is also 4.
  assert.deepEqual(
    listPanes(PROJECTS).map((e) => `${e.projectSlug}/${e.name}/${e.terminalId}`),
    ["alpha/build/t1", "alpha/reviewer/t2", "beta/build/t3", "beta/deploy/t4"],
  );
});

test("listPanes carries each pane's preset", () => {
  const projects = [
    project("alpha", [["t1", "build", "codex"], ["t2", "reviewer", "claude"]]),
  ];
  assert.deepEqual(
    listPanes(projects).map((e) => e.presetId),
    ["codex", "claude"],
  );
});

test("listPanes marks the caller's own pane and nothing else", () => {
  const entries = listPanes(PROJECTS, { projectSlug: "alpha", selfTerminalId: "t2" });
  assert.deepEqual(
    entries.filter((e) => e.isSelf).map((e) => e.name),
    ["reviewer"],
  );
});

test("formatPaneList renders name, preset and id, and marks only the caller", () => {
  const projects = [
    project("alpha", [["t1", "build", "codex"], ["t2", "reviewer", "claude"]]),
  ];
  const out = formatPaneList(listPanes(projects, { selfTerminalId: "t1" }));
  // Whole rows: loose fragments left the id column undefended, and the id is the
  // only unambiguous handle for pane read/send, so dropping it shipped green.
  assert.equal(
    out,
    "* build     codex   t1  (this pane)\n  reviewer  claude  t2\n",
  );
});

test("formatPaneList shows a project header only when spanning projects", () => {
  // A display name distinct from the slug: the shared PROJECTS fixture sets
  // name === slug, which cannot tell WHICH field is printed.
  const named = [
    { slug: "alpha", name: "Alpha Project", directory: "/alpha",
      tabs: [{ id: "t1", presetId: "codex", name: "build" }] },
    { slug: "beta", name: "Beta Project", directory: "/beta",
      tabs: [{ id: "t2", presetId: "claude", name: "deploy" }] },
  ];
  const single = formatPaneList(listPanes(named, { projectSlug: "alpha" }));
  assert.doesNotMatch(single, /Alpha Project/);

  const both = formatPaneList(listPanes(named));
  assert.match(both, /Alpha Project \(alpha\):/);
  assert.match(both, /Beta Project \(beta\):/);
  // Exactly one header per project - not one before every row.
  assert.equal(both.split("\n").filter((l) => l.endsWith(":")).length, 2);
});

test("formatPaneList on no panes says so", () => {
  assert.match(formatPaneList([]), /No panes found/);
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
  // The literal, not the constant: comparing against PANE_READ_MAX_CHARS moves
  // both sides together and stays green for any cap.
  assert.equal(PANE_READ_MAX_CHARS, 64_000);
  const out = tailForPaneRead("x".repeat(PANE_READ_MAX_CHARS) + "TAIL");
  assert.equal(out.length, 64_000);
  // The DEFAULT path keeps the tail too, not just the explicit-size one.
  assert.ok(out.endsWith("TAIL"), "must keep the END, not the start");
});
