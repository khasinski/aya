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
