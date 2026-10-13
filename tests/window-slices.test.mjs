// Multi-window project slices: disk keeps ONE state whose `open` is the union
// across windows; which window shows which project is session-only. These
// semantics decide what each window boots with and what lands on disk, so a
// regression here silently drops or duplicates open projects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowProjectSlices } from "../dist-electron/window-slices.js";

const disk = (over = {}) => ({
  version: 1,
  order: ["a", "b", "c"],
  open: ["a", "b"],
  recent: ["c"],
  activeProject: "b",
  activeTab: { a: "t-a", b: "t-b" },
  ...over,
});

test("boot window claims the whole on-disk open list; later windows start empty", () => {
  const s = new WindowProjectSlices();
  const w1 = s.stateForWindow(disk(), 1, true);
  assert.deepEqual(w1.open, ["a", "b"]);
  assert.equal(w1.activeProject, "b");
  const w2 = s.stateForWindow(disk(), 2, false);
  assert.deepEqual(w2.open, []);
  assert.equal(w2.activeProject, null);
});

test("a claimed slice is sticky (second read returns the same slice)", () => {
  const s = new WindowProjectSlices();
  s.stateForWindow(disk(), 1, true);
  s.mergeSave(disk({ open: ["a"] }), 1, disk());
  const again = s.stateForWindow(disk(), 1, true);
  assert.deepEqual(again.open, ["a"]);
});

test("mergeSave writes the union of all windows to disk state", () => {
  const s = new WindowProjectSlices();
  s.stateForWindow(disk(), 1, true); // window 1 -> [a, b]
  s.stateForWindow(disk(), 2, false); // window 2 -> []
  const merged = s.mergeSave(disk({ open: ["c"] }), 2, disk());
  assert.deepEqual(merged.open, ["a", "b", "c"]);
  // Window 2 remembers its slice; window 1 untouched.
  assert.deepEqual(s.stateForWindow(disk(), 2, false).open, ["c"]);
  assert.deepEqual(s.stateForWindow(disk(), 1, true).open, ["a", "b"]);
});

test("mergeSave keeps activeTab entries from disk and other windows", () => {
  const s = new WindowProjectSlices();
  s.stateForWindow(disk(), 1, true);
  s.mergeSave(disk({ open: ["a", "b"], activeTab: { a: "t-a2", b: "t-b" } }), 1, disk());
  // Window 2 saves only its own project's tab; a/b survive from window 1+disk.
  const merged = s.mergeSave(
    disk({ open: ["c"], activeTab: { c: "t-c" } }),
    2,
    disk(),
  );
  assert.deepEqual(merged.activeTab, { a: "t-a2", b: "t-b", c: "t-c" });
});

test("release returns the dead window's slugs and shrinks the union", () => {
  const s = new WindowProjectSlices();
  s.stateForWindow(disk(), 1, true);
  s.mergeSave(disk({ open: ["c"] }), 2, disk());
  const released = s.release(2);
  assert.deepEqual(released, ["c"]);
  assert.deepEqual(s.openUnion(), ["a", "b"]);
  // Releasing an unknown window is a no-op.
  assert.deepEqual(s.release(99), []);
});

test("windowOf finds the owning window; null for closed projects", () => {
  const s = new WindowProjectSlices();
  s.stateForWindow(disk(), 1, true);
  s.mergeSave(disk({ open: ["c"] }), 2, disk());
  assert.equal(s.windowOf("a"), 1);
  assert.equal(s.windowOf("c"), 2);
  assert.equal(s.windowOf("nope"), null);
});

test("per-window activeProject is remembered and validated against the slice", () => {
  const s = new WindowProjectSlices();
  s.stateForWindow(disk(), 1, true);
  s.mergeSave(disk({ open: ["a", "b"], activeProject: "a" }), 1, disk());
  assert.equal(s.stateForWindow(disk(), 1, true).activeProject, "a");
  // Active project that left the slice falls back to the first open slug.
  s.mergeSave(disk({ open: ["b"], activeProject: "a" }), 1, disk());
  assert.equal(s.stateForWindow(disk(), 1, true).activeProject, "b");
});

// --- resolveDropTarget (tab tear-out hit-testing) ------------------------------

test("drop inside the source window is 'self' even when windows overlap", async () => {
  const { resolveDropTarget } = await import("../dist-electron/window-slices.js");
  const candidates = [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, isSelf: true },
    { id: 2, bounds: { x: 400, y: 0, width: 800, height: 600 }, isSelf: false },
  ];
  // Point inside BOTH windows: self must win (never tear out of your own drop).
  assert.deepEqual(resolveDropTarget(500, 100, candidates), { kind: "self" });
});

test("drop inside another window attaches there", async () => {
  const { resolveDropTarget } = await import("../dist-electron/window-slices.js");
  const candidates = [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, isSelf: true },
    { id: 2, bounds: { x: 900, y: 0, width: 800, height: 600 }, isSelf: false },
  ];
  assert.deepEqual(resolveDropTarget(1000, 300, candidates), {
    kind: "window",
    id: 2,
  });
});

test("drop on empty desktop tears out into a new window", async () => {
  const { resolveDropTarget } = await import("../dist-electron/window-slices.js");
  const candidates = [
    { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, isSelf: true },
  ];
  assert.deepEqual(resolveDropTarget(1200, 900, candidates), { kind: "new" });
  // Boundary points count as inside (releasing at the very edge stays put).
  assert.deepEqual(resolveDropTarget(800, 600, candidates), { kind: "self" });
});

// The lifecycle wiring moved from main: boot readiness and trimming a closed window on disk.
function lifecycle(over = {}) {
  const calls = [];
  let quitting = false;
  const deps = {
    listProjectState: async () => { calls.push(["load"]); return disk({ recent: ["c", "b", "d"] }); },
    saveProjectState: async (state) => { calls.push(["save", state]); },
    quitting: () => quitting,
    ...over,
  };
  return { deps, calls, quit: () => { quitting = true; } };
}

const { createWindowProjectState } = await import("../dist-electron/window-slices.js");

test("boot readiness changes only when the first claimed window reads its state", () => {
  const s = createWindowProjectState(lifecycle().deps);
  s.claimBootWindow(10);
  s.claimBootWindow(20);
  assert.equal(s.bootProjectsLoaded, false);
  assert.deepEqual(s.projectStateForWindow(disk(), 20).open, []);
  assert.equal(s.bootProjectsLoaded, false);
  const boot = s.projectStateForWindow(disk(), 10);
  assert.deepEqual(boot.open, ["a", "b"]);
  assert.equal(boot.secondaryWindow, false);
  assert.equal(s.bootProjectsLoaded, true);
});

test("closing a window removes its slice before loading disk, then prepends released projects to recent", async () => {
  const l = lifecycle();
  const s = createWindowProjectState(l.deps);
  s.claimBootWindow(1);
  s.projectStateForWindow(disk(), 1);
  s.windowSlices.mergeSave(disk({ open: ["c"] }), 2, disk());
  l.deps.listProjectState = async () => {
    assert.deepEqual(s.windowSlices.openUnion(), ["c"]);
    assert.equal(s.windowSlices.windowOf("a"), null);
    l.calls.push(["load"]);
    return disk({ recent: ["c", "b", "d"] });
  };
  await s.releaseWindowSlices(1);
  assert.deepEqual(l.calls, [["load"], ["save", disk({ open: ["c"], recent: ["a", "b", "c", "d"] })]]);
});

test("released projects still open in another slice are excluded from the new recent prefix", async () => {
  const l = lifecycle();
  const s = createWindowProjectState(l.deps);
  s.claimBootWindow(1);
  s.projectStateForWindow(disk(), 1);
  s.windowSlices.mergeSave(disk({ open: ["b", "c"] }), 2, disk());
  await s.releaseWindowSlices(1);
  assert.deepEqual(l.calls[1][1], disk({ open: ["b", "c"], recent: ["a", "c", "d"] }));
});

test("empty releases and releases during quit still clear slices without touching disk", async () => {
  const l = lifecycle();
  const s = createWindowProjectState(l.deps);
  s.claimBootWindow(1);
  s.projectStateForWindow(disk(), 1);
  await s.releaseWindowSlices(99);
  assert.deepEqual(l.calls, []);
  l.quit();
  await s.releaseWindowSlices(1);
  assert.deepEqual(s.windowSlices.openUnion(), []);
  assert.deepEqual(l.calls, []);
});

test("failed disk reads and writes are best effort after the in-memory slice is released", async () => {
  for (const failing of ["listProjectState", "saveProjectState"]) {
    let failures = 0;
    const l = lifecycle({ [failing]: async () => { failures++; throw new Error("disk unavailable"); } });
    const s = createWindowProjectState(l.deps);
    s.claimBootWindow(1);
    s.projectStateForWindow(disk(), 1);
    await s.releaseWindowSlices(1);
    assert.equal(failures, 1);
    assert.deepEqual(s.windowSlices.openUnion(), []);
  }
});

// Once the original boot window closes, later windows intentionally remain secondary.
test("closing the boot window leaves the original boot id and readiness in place", async () => {
  const s = createWindowProjectState(lifecycle().deps);
  s.claimBootWindow(1);
  s.projectStateForWindow(disk(), 1);
  await s.releaseWindowSlices(1);
  s.claimBootWindow(2);
  assert.equal(s.projectStateForWindow(disk(), 2).secondaryWindow, true);
  assert.deepEqual(s.projectStateForWindow(disk(), 2).open, []);
  assert.equal(s.bootProjectsLoaded, true);
});
