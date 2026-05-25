// Tab-shape migration: pre-presets aya stored `kind: "claude" | "codex" | "shell"`;
// post-presets uses `presetId: string`. The loader must accept both and
// emit the new shape with `name` backfilled when missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTab } from "../dist-electron/config.js";

test("normalizes a new-format tab (presetId + name)", () => {
  const out = normalizeTab({
    id: "abc",
    presetId: "claude",
    name: "main-claude",
  });
  assert.deepEqual(out, { id: "abc", presetId: "claude", name: "main-claude" });
});

test("migrates old-format tab (`kind` → `presetId`)", () => {
  const out = normalizeTab({ id: "abc", kind: "codex", name: "feature-branch" });
  assert.deepEqual(out, {
    id: "abc",
    presetId: "codex",
    name: "feature-branch",
  });
});

test("backfills name from presetId when missing", () => {
  const out = normalizeTab({ id: "abc", kind: "shell" });
  assert.deepEqual(out, { id: "abc", presetId: "shell", name: "shell" });
});

test("backfills name when the existing name is blank", () => {
  const out = normalizeTab({ id: "abc", presetId: "claude", name: "   " });
  assert.equal(out.name, "claude");
});

test("accepts arbitrary presetIds (user-defined presets)", () => {
  const out = normalizeTab({ id: "abc", presetId: "my-custom-preset" });
  assert.equal(out?.presetId, "my-custom-preset");
});

test("rejects tab without id", () => {
  assert.equal(normalizeTab({ presetId: "shell" }), null);
});

test("rejects tab without presetId or kind", () => {
  assert.equal(normalizeTab({ id: "abc" }), null);
  assert.equal(normalizeTab({ id: "abc", kind: "" }), null);
  assert.equal(normalizeTab({ id: "abc", presetId: "" }), null);
});

test("rejects non-object input", () => {
  assert.equal(normalizeTab(null), null);
  assert.equal(normalizeTab(undefined), null);
  assert.equal(normalizeTab("string"), null);
  assert.equal(normalizeTab(42), null);
});
