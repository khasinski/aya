import type { SplitNode } from "../shared/split-node.cjs";
import { isSplitNode as commonIsSplitNode } from "../shared/split-node.cjs";
export type { SplitNode } from "../shared/split-node.cjs";


/** Maximum split-grid dimensions (rows x cols): the clamp in config.ts and the
 *  IPC validator enforce the same rule. */
export const MAX_SPLIT_ROWS = 5;
export const MAX_SPLIT_COLS = 5;
export const MAX_SPLIT_LEAVES = MAX_SPLIT_ROWS * MAX_SPLIT_COLS;
// A fully-degenerate tree of MAX_SPLIT_LEAVES leaves is one level per extra leaf.
export const MAX_SPLIT_DEPTH = MAX_SPLIT_LEAVES - 1;

export function isSplitNode(value: unknown, depth = 0): value is SplitNode { return commonIsSplitNode(value, depth); }

export function splitTreeLeafCount(node: SplitNode): number {
  return node.kind === "leaf"
    ? 1
    : splitTreeLeafCount(node.first) + splitTreeLeafCount(node.second);
}

/** A tree is storable when its shape is valid and it stays within the pane cap
 *  — an oversized layout would be rendered but could never be reproduced by
 *  the UI, so it is rejected at the boundary instead. */
export function isStorableSplitTree(value: unknown): value is SplitNode {
  return isSplitNode(value) && splitTreeLeafCount(value) <= MAX_SPLIT_LEAVES;
}

/** Drop terminal ids that no longer exist, and any duplicate placement. Shape
 *  only — collapsing emptied subtrees is the renderer's job (it needs the
 *  fallback terminal and id generator to do it properly). */
export function pruneSplitTreeTerminals(
  node: SplitNode,
  tabIds: ReadonlySet<string>,
  seen: Set<string> = new Set(),
): SplitNode {
  if (node.kind === "leaf") {
    const id = node.terminalId;
    if (!id || !tabIds.has(id) || seen.has(id)) {
      return node.terminalId === null ? node : { ...node, terminalId: null };
    }
    seen.add(id);
    return node;
  }
  const first = pruneSplitTreeTerminals(node.first, tabIds, seen);
  const second = pruneSplitTreeTerminals(node.second, tabIds, seen);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}
