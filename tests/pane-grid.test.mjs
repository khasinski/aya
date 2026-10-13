import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyProjectPaneTitle,
  paneStyleFromRect,
} from "../dist-test/pane-grid.js";
import { assignTerminal, layoutRects, leaf, splitLeaf } from "../dist-test/split-tree.js";

test("single panes have no positioning style even for a partial rectangle", () => {
  assert.equal(paneStyleFromRect(false, {
    left: 25, top: 50, width: 75, height: 50,
  }), undefined);
});

test("split pane styles preserve zeroes and fractional percentages without mutating the rectangle", () => {
  const rect = Object.freeze({ left: 0, top: 18.125, width: 33.333333333333336, height: 0 });
  assert.deepEqual(paneStyleFromRect(true, rect), {
    left: "0%", top: "18.125%", width: "33.333333333333336%", height: "0%",
  });
});

test("nested split rectangles become flat pane positions in layout order", () => {
  const pair = assignTerminal(
    splitLeaf(leaf("left", "t1"), "left", "row", "columns", "right"), "right", "t2",
  );
  const tree = assignTerminal(
    splitLeaf(pair, "right", "column", "rows", "bottom"), "bottom", "t3",
  );
  const panes = layoutRects(tree);
  assert.deepEqual(panes.map(({ leafId, terminalId, rect }) => ({
    leafId, terminalId, style: paneStyleFromRect(true, rect),
  })), [
    { leafId: "left", terminalId: "t1", style: { left: "0%", top: "0%", width: "50%", height: "100%" } },
    { leafId: "right", terminalId: "t2", style: { left: "50%", top: "0%", width: "50%", height: "50%" } },
    { leafId: "bottom", terminalId: "t3", style: { left: "50%", top: "50%", width: "50%", height: "50%" } },
  ]);
});

test("local projects without terminals keep the launch hint", () => {
  assert.equal(emptyProjectPaneTitle({ slug: "local" }), "No terminals yet — launch one to get started.");
});

test("remote projects without terminals show the remote label verbatim", () => {
  assert.equal(emptyProjectPaneTitle({ remote: { label: "Builder <eu>" } }), "Remote project on Builder <eu>");
  assert.equal(emptyProjectPaneTitle({ remote: { label: "" } }), "Remote project on ");
});
