// BSP pane layout. This replaced a flat rows x cols grid whose defining flaw
// was that splitting inserted a whole track and resized every pane sharing it.
// The headline assertion here is the opposite: splitting one pane leaves its
// neighbours exactly where they were.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SPLIT_LEAVES,
  MIN_SPLIT_PANE_FRACTION,
  assignTerminal,
  assignedTerminalIds,
  compactTree,
  dividerRects,
  findLeafByTerminal,
  focusDirection,
  isSplitNode,
  layoutRects,
  leaf,
  leafCount,
  leaves,
  normalizeTreeForTabs,
  removeLeaf,
  removeTerminal,
  resizeSplit,
  splitLeaf,
  treeDepth,
  treeFromLegacyLayout,
} from "../dist-test/split-tree.js";

// Deterministic ids keep the assertions readable.
function idGen(prefix = "n") {
  let i = 0;
  return () => `${prefix}${++i}`;
}

const MIGRATION_2x2 = {
  rows: 2,
  cols: 2,
  rowFr: [1, 1],
  colFr: [1, 1],
  cells: ["t1", "t2", "t3", "t4"],
  activeCell: 0,
};

const rectOf = (tree, leafId) =>
  layoutRects(tree).find((r) => r.leafId === leafId)?.rect;

/** Two panes side by side: A | B */
function pairTree() {
  return splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
}

// --- splitting -------------------------------------------------------------

test("splitting a leaf replaces it with a half-and-half split", () => {
  const tree = pairTree();
  assert.equal(tree.kind, "split");
  assert.equal(tree.direction, "row");
  assert.equal(tree.ratio, 0.5);
  assert.equal(leafCount(tree), 2);
  // The original terminal stays in the first half; the new pane is empty.
  assert.equal(tree.first.terminalId, "t1");
  assert.equal(tree.second.terminalId, null);
});

test("splitting ONE pane does not move or resize its neighbours", () => {
  // The whole reason for the tree. In the old grid, splitting the right pane
  // added a column and shrank the left pane too.
  const base = pairTree(); // a | b, 50/50
  const leftBefore = rectOf(base, "a");
  const split = splitLeaf(base, "b", "column", "s2", "c");
  const leftAfter = rectOf(split, "a");
  assert.deepEqual(leftAfter, leftBefore, "left pane must be untouched");
  // The right half is the only area divided.
  assert.deepEqual(rectOf(split, "b"), { left: 50, top: 0, width: 50, height: 50 });
  assert.deepEqual(rectOf(split, "c"), { left: 50, top: 50, width: 50, height: 50 });
});

test("splitting is refused once the pane cap is reached", () => {
  let tree = leaf("l0", "t0");
  const ids = idGen("x");
  for (let i = 0; i < MAX_SPLIT_LEAVES + 5; i += 1) {
    const target = leaves(tree)[0];
    tree = splitLeaf(tree, target.id, "row", ids(), ids());
  }
  assert.equal(leafCount(tree), MAX_SPLIT_LEAVES);
});

// --- geometry --------------------------------------------------------------

test("rects tile the container exactly: no gaps, no overlaps", () => {
  let tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  tree = splitLeaf(tree, "b", "column", "s2", "c");
  tree = splitLeaf(tree, "a", "column", "s3", "d");
  const rects = layoutRects(tree).map((r) => r.rect);

  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(Math.abs(area - 100 * 100) < 0.001, `area was ${area}`);

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlap =
        a.left < b.left + b.width - 0.001 &&
        b.left < a.left + a.width - 0.001 &&
        a.top < b.top + b.height - 0.001 &&
        b.top < a.top + a.height - 0.001;
      assert.equal(overlap, false, `rects ${i} and ${j} overlap`);
    }
  }
});

test("a single leaf fills the whole container", () => {
  assert.deepEqual(layoutRects(leaf("a", "t1")), [
    { leafId: "a", terminalId: "t1", rect: { left: 0, top: 0, width: 100, height: 100 } },
  ]);
});

test("one divider per split, on the boundary between its children", () => {
  const tree = pairTree();
  const dividers = dividerRects(tree);
  assert.equal(dividers.length, 1);
  assert.equal(dividers[0].splitId, "s1");
  assert.equal(dividers[0].direction, "row");
  assert.equal(dividers[0].rect.left, 50);
  assert.equal(dividers[0].rect.height, 100);
  assert.equal(dividerRects(leaf("a", null)).length, 0);
});

// --- resize ----------------------------------------------------------------

test("resizing a split moves only that boundary", () => {
  const tree = resizeSplit(pairTree(), "s1", 0.3);
  assert.deepEqual(rectOf(tree, "a"), { left: 0, top: 0, width: 30, height: 100 });
  assert.deepEqual(rectOf(tree, "b"), { left: 30, top: 0, width: 70, height: 100 });
});

test("a pane cannot be dragged below the minimum fraction", () => {
  const tiny = resizeSplit(pairTree(), "s1", 0.01);
  assert.equal(tiny.ratio, MIN_SPLIT_PANE_FRACTION);
  const huge = resizeSplit(pairTree(), "s1", 0.99);
  assert.equal(huge.ratio, 1 - MIN_SPLIT_PANE_FRACTION);
});

test("resizing an unknown split is a no-op returning the same reference", () => {
  const tree = pairTree();
  assert.equal(resizeSplit(tree, "ghost", 0.4), tree);
});

// --- assignment ------------------------------------------------------------

test("assigning a terminal removes it from whatever pane held it", () => {
  // Two panes showing the same PTY would be a real bug, not a feature.
  let tree = pairTree(); // a=t1, b=empty
  tree = assignTerminal(tree, "b", "t1");
  assert.equal(findLeafByTerminal(tree, "t1").id, "b");
  assert.deepEqual(assignedTerminalIds(tree), ["t1"]);
});

test("removing a terminal collapses its pane into the sibling", () => {
  const tree = assignTerminal(pairTree(), "b", "t2");
  const after = removeTerminal(tree, "t2");
  assert.equal(after.kind, "leaf");
  assert.equal(after.terminalId, "t1");
});

test("removing the only leaf's terminal empties it rather than the tree", () => {
  const after = removeLeaf(leaf("a", "t1"), "a");
  assert.equal(after.kind, "leaf");
  assert.equal(after.terminalId, null);
});

// --- normalization ---------------------------------------------------------

test("unknown and duplicate terminal ids are cleared", () => {
  let tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  tree = assignTerminal(tree, "b", "t2");
  // Forge a duplicate the way a corrupted config could.
  tree = { ...tree, second: { ...tree.second, terminalId: "t1" } };
  const normalized = normalizeTreeForTabs(tree, new Set(["t1"]), "t1", "new");
  assert.deepEqual(assignedTerminalIds(normalized), ["t1"]);
});

test("a pane whose terminal closed stays as a fillable empty placeholder", () => {
  // The old grid kept an emptied cell too. Collapsing here would undo a split
  // the instant the user made it, since a fresh pane starts empty.
  let tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  tree = assignTerminal(tree, "b", "t2");
  const normalized = normalizeTreeForTabs(tree, new Set(["t1"]), "t1", "new");
  assert.equal(normalized.kind, "split");
  assert.equal(leafCount(normalized), 2);
  assert.deepEqual(assignedTerminalIds(normalized), ["t1"]);
});

test("a split with nothing left in it collapses to a single pane", () => {
  let tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  tree = assignTerminal(tree, "b", "t2");
  // Both terminals gone: the whole split is dead space.
  const normalized = normalizeTreeForTabs(tree, new Set(), null, "new");
  assert.equal(normalized.kind, "leaf");
});

test("a freshly split pane survives normalization", () => {
  // Regression: the empty half of a new split was being collapsed away, so
  // splitting appeared to do nothing at all.
  const tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  const normalized = normalizeTreeForTabs(tree, new Set(["t1"]), "t1", "new");
  assert.equal(normalized.kind, "split");
  assert.equal(leafCount(normalized), 2);
});

test("an absent tree becomes a single pane holding the fallback", () => {
  const tree = normalizeTreeForTabs(undefined, new Set(["t1"]), "t1", "new");
  assert.deepEqual(tree, { kind: "leaf", id: "new", terminalId: "t1" });
});

test("an all-empty tree gets the fallback placed in its first pane", () => {
  const empty = splitLeaf(leaf("a", null), "a", "row", "s1", "b");
  const tree = normalizeTreeForTabs(empty, new Set(["t1"]), "t1", "new");
  assert.deepEqual(assignedTerminalIds(tree), ["t1"]);
});

test("compactTree reports a lone pane as 'no split' so it isn't persisted", () => {
  assert.equal(compactTree(leaf("a", "t1")), undefined);
  assert.ok(compactTree(assignTerminal(pairTree(), "b", "t2")));
});

// --- directional focus -----------------------------------------------------

test("focus moves to the adjacent pane in each direction", () => {
  // a | b   with b split into b (top) and c (bottom)
  let tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  tree = splitLeaf(tree, "b", "column", "s2", "c");
  assert.equal(focusDirection(tree, "a", "right"), "b");
  assert.equal(focusDirection(tree, "b", "left"), "a");
  assert.equal(focusDirection(tree, "b", "down"), "c");
  assert.equal(focusDirection(tree, "c", "up"), "b");
});

test("focus past an edge is null, not a wrap-around", () => {
  const tree = pairTree();
  assert.equal(focusDirection(tree, "a", "left"), null);
  assert.equal(focusDirection(tree, "b", "right"), null);
  assert.equal(focusDirection(tree, "a", "up"), null);
});

test("focus picks the nearest overlapping pane, not one merely in that half", () => {
  // Left column full height; right column split in two. From the LEFT pane,
  // moving right must pick the top-right pane (closest centre), not the
  // bottom one.
  let tree = splitLeaf(leaf("a", "t1"), "a", "row", "s1", "b");
  tree = splitLeaf(tree, "b", "column", "s2", "c");
  tree = resizeSplit(tree, "s2", 0.8); // b tall, c short
  assert.equal(focusDirection(tree, "a", "right"), "b");
});

test("focus from an unknown leaf is null", () => {
  assert.equal(focusDirection(pairTree(), "ghost", "right"), null);
});

// --- legacy migration ------------------------------------------------------

test("a 1x2 grid migrates to an equivalent side-by-side tree", () => {
  const tree = treeFromLegacyLayout({ rows: 1, cols: 2, rowFr: [1], colFr: [1, 1], cells: ["t1", "t2"], activeCell: 0 },
);
  assert.equal(leafCount(tree), 2);
  assert.deepEqual(assignedTerminalIds(tree), ["t1", "t2"]);
  const rects = layoutRects(tree);
  assert.deepEqual(rects[0].rect, { left: 0, top: 0, width: 50, height: 100 });
  assert.deepEqual(rects[1].rect, { left: 50, top: 0, width: 50, height: 100 });
});

test("a 2x2 grid migrates preserving every cell's position", () => {
  const tree = treeFromLegacyLayout({
      rows: 2,
      cols: 2,
      rowFr: [1, 1],
      colFr: [1, 1],
      cells: ["t1", "t2", "t3", "t4"],
      activeCell: 0,
    },
);
  assert.equal(leafCount(tree), 4);
  const byTerminal = Object.fromEntries(
    layoutRects(tree).map((r) => [r.terminalId, r.rect]),
  );
  assert.deepEqual(byTerminal.t1, { left: 0, top: 0, width: 50, height: 50 });
  assert.deepEqual(byTerminal.t2, { left: 50, top: 0, width: 50, height: 50 });
  assert.deepEqual(byTerminal.t3, { left: 0, top: 50, width: 50, height: 50 });
  assert.deepEqual(byTerminal.t4, { left: 50, top: 50, width: 50, height: 50 });
});

test("uneven track sizes survive migration as ratios", () => {
  const tree = treeFromLegacyLayout({ rows: 1, cols: 2, rowFr: [1], colFr: [3, 1], cells: ["t1", "t2"], activeCell: 0 },
);
  const rects = layoutRects(tree);
  assert.ok(Math.abs(rects[0].rect.width - 75) < 0.001);
  assert.ok(Math.abs(rects[1].rect.width - 25) < 0.001);
});

test("a 1x1 grid migrates to a bare leaf", () => {
  const tree = treeFromLegacyLayout({ rows: 1, cols: 1, rowFr: [1], colFr: [1], cells: ["t1"], activeCell: 0 },
);
  assert.deepEqual(tree, { kind: "leaf", id: "mig-r0c0", terminalId: "t1" });
});

test("a 1x3 grid keeps all three panes in order", () => {
  const tree = treeFromLegacyLayout({
      rows: 1,
      cols: 3,
      rowFr: [1],
      colFr: [1, 1, 1],
      cells: ["t1", "t2", "t3"],
      activeCell: 0,
    },
);
  assert.deepEqual(assignedTerminalIds(tree), ["t1", "t2", "t3"]);
  const rects = layoutRects(tree).map((r) => r.rect.left);
  assert.ok(rects[0] < rects[1] && rects[1] < rects[2], "panes must stay ordered");
});

test("empty grid cells migrate to empty panes, not dropped ones", () => {
  const tree = treeFromLegacyLayout({ rows: 1, cols: 2, rowFr: [1], colFr: [1, 1], cells: ["t1", null], activeCell: 0 },
);
  assert.equal(leafCount(tree), 2);
  assert.deepEqual(assignedTerminalIds(tree), ["t1"]);
});

// --- shape validation ------------------------------------------------------

test("isSplitNode accepts well-formed trees and rejects junk", () => {
  assert.equal(isSplitNode(pairTree()), true);
  assert.equal(isSplitNode(leaf("a", null)), true);
  assert.equal(isSplitNode(null), false);
  assert.equal(isSplitNode({ kind: "leaf" }), false, "missing id");
  assert.equal(isSplitNode({ kind: "nope", id: "x" }), false);
});

test("isSplitNode rejects ratios that would collapse or invert a pane", () => {
  const bad = (ratio) => ({
    kind: "split",
    id: "s",
    direction: "row",
    ratio,
    first: leaf("a", null),
    second: leaf("b", null),
  });
  assert.equal(isSplitNode(bad(0)), false);
  assert.equal(isSplitNode(bad(1)), false);
  assert.equal(isSplitNode(bad(-0.5)), false);
  assert.equal(isSplitNode(bad(Number.NaN)), false);
});

test("isSplitNode rejects a tree nested past the depth cap", () => {
  let tree = leaf("l0", null);
  const ids = idGen("d");
  for (let i = 0; i < 40; i += 1) {
    tree = {
      kind: "split",
      id: ids(),
      direction: "row",
      ratio: 0.5,
      first: leaf(ids(), null),
      second: tree,
    };
  }
  assert.ok(treeDepth(tree) > 24);
  assert.equal(isSplitNode(tree), false);
});

test("migration is idempotent: the same grid always yields the same ids", () => {
  // Migration runs on every read until the first save rewrites the project as
  // a tree. With generated ids, a remembered focused-pane id would never match
  // the next tree and pane navigation silently did nothing.
  const a = treeFromLegacyLayout(MIGRATION_2x2);
  const b = treeFromLegacyLayout(MIGRATION_2x2);
  assert.deepEqual(a, b);
  assert.deepEqual(
    leaves(a).map((l) => l.id),
    leaves(b).map((l) => l.id),
  );
});
