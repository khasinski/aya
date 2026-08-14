// Main-process view of the pane layout tree.
//
// The renderer owns the layout ALGEBRA (src/split-tree.ts: splitting, resizing,
// geometry, and the migration from the pre-tree grid format). The main process
// only ever needs to answer "is this shape safe to store / accept over IPC?",
// so this file deliberately stays a type plus a validator rather than a second
// copy of the algorithm that could drift from the real one.
//
// Kept in step with src/split-tree.ts the same way electron/types.ts is kept in
// step with src/types.ts — deliberate duplication so the two TS projects stay
// independent. tests/split-tree-parity.test.mjs pins the two validators
// together.

export type SplitNode =
  | { kind: "leaf"; id: string; terminalId: string | null }
  | {
      kind: "split";
      id: string;
      direction: "row" | "column";
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

export const MAX_SPLIT_LEAVES = 25;
export const MAX_SPLIT_DEPTH = 24;

export function isSplitNode(value: unknown, depth = 0): value is SplitNode {
  if (depth > MAX_SPLIT_DEPTH) return false;
  if (typeof value !== "object" || value === null) return false;
  const n = value as Record<string, unknown>;
  if (typeof n.id !== "string" || !n.id) return false;
  if (n.kind === "leaf") {
    return n.terminalId === null || typeof n.terminalId === "string";
  }
  if (n.kind !== "split") return false;
  if (n.direction !== "row" && n.direction !== "column") return false;
  if (typeof n.ratio !== "number" || !Number.isFinite(n.ratio) || n.ratio <= 0 || n.ratio >= 1) {
    return false;
  }
  return isSplitNode(n.first, depth + 1) && isSplitNode(n.second, depth + 1);
}

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
