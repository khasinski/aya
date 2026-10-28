// The four window layouts are the cross product of two stored preferences; the mapping must be
// total and reversible, or a stored pair would show no option as selected.

import { test } from "node:test";
import assert from "node:assert/strict";

import { WINDOW_LAYOUTS, windowLayoutOf, windowLayoutParts } from "../dist-test/window-layout.js";

test("every (layoutMode, chromeStyle) pair maps to one layout and back", () => {
  const pairs = [];
  for (const layoutMode of ["classic", "projects-left"]) {
    for (const chromeStyle of ["classic", "command-rail"]) pairs.push({ layoutMode, chromeStyle });
  }
  assert.equal(WINDOW_LAYOUTS.length, pairs.length);
  assert.equal(new Set(WINDOW_LAYOUTS.map((l) => l.id)).size, pairs.length);
  for (const pair of pairs) {
    assert.deepEqual(windowLayoutParts(windowLayoutOf(pair.layoutMode, pair.chromeStyle)), pair);
  }
});

test("the layouts keep their pre-existing pairs", () => {
  assert.equal(windowLayoutOf("classic", "classic"), "top");
  assert.equal(windowLayoutOf("projects-left", "classic"), "left");
  assert.equal(windowLayoutOf("classic", "command-rail"), "command-rail");
  assert.equal(windowLayoutOf("projects-left", "command-rail"), "command-rail-left");
});
