// The layout tree is validated in two independent TS projects: the renderer
// (src/split-tree.ts, which owns the algebra) and the main process
// (electron/split-tree.ts, which only guards the boundary). They are separate
// files on purpose — electron/ never imports from src/ — so this pins them
// together. If one starts accepting a shape the other rejects, a layout the UI
// can produce would be refused on save (or vice versa: junk would reach disk).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isSplitNode as rendererIsSplitNode } from "../dist-test/split-tree.js";
import {
  MAX_SPLIT_DEPTH as electronMaxDepth,
  MAX_SPLIT_LEAVES as electronMaxLeaves,
  isSplitNode as electronIsSplitNode,
  splitTreeLeafCount,
} from "../dist-electron/split-tree.js";
import {
  MAX_SPLIT_DEPTH as rendererMaxDepth,
  MAX_SPLIT_LEAVES as rendererMaxLeaves,
  leafCount,
  leaf,
  splitLeaf,
} from "../dist-test/split-tree.js";

const split = (id, direction, ratio, first, second) => ({
  kind: "split",
  id,
  direction,
  ratio,
  first,
  second,
});

const CASES = [
  ["a bare leaf", { kind: "leaf", id: "a", terminalId: null }],
  ["a leaf holding a terminal", { kind: "leaf", id: "a", terminalId: "t1" }],
  ["a simple split", split("s", "row", 0.5, leaf("a", "t1"), leaf("b", null))],
  ["a column split", split("s", "column", 0.25, leaf("a", null), leaf("b", null))],
  ["null", null],
  ["undefined", undefined],
  ["a plain object", {}],
  ["an array", []],
  ["a leaf with no id", { kind: "leaf", terminalId: null }],
  ["a leaf with an empty id", { kind: "leaf", id: "", terminalId: null }],
  ["a leaf with a numeric terminalId", { kind: "leaf", id: "a", terminalId: 7 }],
  ["an unknown kind", { kind: "branch", id: "a" }],
  ["a split with a bad direction", split("s", "diagonal", 0.5, leaf("a"), leaf("b"))],
  ["a split at ratio 0", split("s", "row", 0, leaf("a"), leaf("b"))],
  ["a split at ratio 1", split("s", "row", 1, leaf("a"), leaf("b"))],
  ["a split at a negative ratio", split("s", "row", -0.3, leaf("a"), leaf("b"))],
  ["a split with a NaN ratio", split("s", "row", Number.NaN, leaf("a"), leaf("b"))],
  ["a split missing a child", { kind: "split", id: "s", direction: "row", ratio: 0.5, first: leaf("a") }],
  ["a split whose child is junk", split("s", "row", 0.5, leaf("a"), "nope")],
];

test("both validators agree on every shape", () => {
  for (const [label, value] of CASES) {
    assert.equal(
      rendererIsSplitNode(value),
      electronIsSplitNode(value),
      `disagreement on ${label}: renderer=${rendererIsSplitNode(value)} electron=${electronIsSplitNode(value)}`,
    );
  }
});

test("both validators reject the same excessive nesting", () => {
  let tree = leaf("l0", null);
  for (let i = 0; i < 40; i += 1) {
    tree = split(`s${i}`, "row", 0.5, leaf(`x${i}`, null), tree);
  }
  assert.equal(rendererIsSplitNode(tree), false);
  assert.equal(electronIsSplitNode(tree), false);
});

test("the two limit constants stay in step", () => {
  assert.equal(rendererMaxLeaves, electronMaxLeaves);
  assert.equal(rendererMaxDepth, electronMaxDepth);
});

test("both sides count panes identically", () => {
  let tree = leaf("a", "t1");
  tree = splitLeaf(tree, "a", "row", "s1", "b");
  tree = splitLeaf(tree, "b", "column", "s2", "c");
  assert.equal(leafCount(tree), splitTreeLeafCount(tree));
  assert.equal(splitTreeLeafCount(tree), 3);
});
