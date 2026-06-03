// Pure filename → slice mapping for the config watcher. The contract
// that matters: known config files map to their slice, and EVERYTHING else —
// especially the `.tmp` scratch files writeFileAtomic creates and the
// out-of-scope project files — maps to null so we never spuriously reload.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WATCHED_CONFIG_FILES,
  sliceForFilename,
} from "../dist-electron/config-watcher-pure.js";

test("maps each watched config file to its slice", () => {
  assert.equal(sliceForFilename("snippets.json"), "snippets");
  assert.equal(sliceForFilename("presets.json"), "presets");
  assert.equal(sliceForFilename("themes.json"), "themes");
});

test("ignores the .tmp scratch files written by atomic-write", () => {
  // writeFileAtomic writes `${file}.${pid}.${rand}.tmp` then renames over it.
  assert.equal(sliceForFilename("snippets.json.12345.ab12cd.tmp"), null);
  assert.equal(sliceForFilename("presets.json.999.zzzzzz.tmp"), null);
  assert.equal(sliceForFilename("themes.json.1.abcdef.tmp"), null);
});

test("ignores files outside the minimal hot-reload scope", () => {
  // projects-state + window-state live in AYA_HOME but are not hot-reloaded;
  // a projects/*.json basename is out of scope entirely.
  assert.equal(sliceForFilename("projects-state.json"), null);
  assert.equal(sliceForFilename("projects-order.json"), null);
  assert.equal(sliceForFilename("open-projects.json"), null);
  assert.equal(sliceForFilename("window-state.json"), null);
  assert.equal(sliceForFilename("agent.json"), null);
  assert.equal(sliceForFilename("aya.sock"), null);
});

test("ignores unrelated and empty names", () => {
  assert.equal(sliceForFilename(""), null);
  assert.equal(sliceForFilename("snippets.JSON"), null); // case-sensitive on purpose
  assert.equal(sliceForFilename(".snippets.json.swp"), null); // editor swapfile
  assert.equal(sliceForFilename("snippets"), null);
});

test("WATCHED_CONFIG_FILES covers exactly the minimal slices", () => {
  assert.deepEqual(Object.values(WATCHED_CONFIG_FILES).sort(), [
    "presets",
    "snippets",
    "themes",
  ]);
});
