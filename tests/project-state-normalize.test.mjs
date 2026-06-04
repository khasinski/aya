// projects-state.json gained optional active-selection fields (activeProject /
// activeTab / singleView). The loader must (a) accept an OLD file that has none
// of them — backward compatibility — defaulting to "no selection", and (b)
// preserve + sanitize them when present, so the active project / terminal / view
// survive a restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectState } from "../dist-electron/config.js";

const base = { version: 1, order: ["a"], open: ["a"], recent: ["a"] };

test("backward compatible: an old file with no active fields loads with empty defaults", () => {
  const out = normalizeProjectState({ ...base });
  assert.equal(out.activeProject, null);
  assert.deepEqual(out.activeTab, {});
  assert.deepEqual(out.singleView, {});
  // the existing fields are untouched
  assert.deepEqual(out.order, ["a"]);
});

test("preserves active selections when present", () => {
  const out = normalizeProjectState({
    ...base,
    activeProject: "a",
    activeTab: { a: "tab-2" },
    singleView: { a: "tab-2" },
  });
  assert.equal(out.activeProject, "a");
  assert.deepEqual(out.activeTab, { a: "tab-2" });
  assert.deepEqual(out.singleView, { a: "tab-2" });
});

test("sanitizes: non-string activeProject -> null, non-string map values dropped", () => {
  const out = normalizeProjectState({
    ...base,
    activeProject: 42,
    activeTab: { a: "tab-1", b: 99, c: null },
    singleView: "not-an-object",
  });
  assert.equal(out.activeProject, null);
  assert.deepEqual(out.activeTab, { a: "tab-1" }); // numeric/null values dropped
  assert.deepEqual(out.singleView, {});
});

test("still rejects a file missing the required arrays", () => {
  assert.equal(normalizeProjectState({ version: 1, order: ["a"] }), null);
  assert.equal(normalizeProjectState(null), null);
});
