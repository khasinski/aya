// Pane layout as a binary space partition tree.
//
// This replaces a flat rows x cols grid, where splitting inserted a whole track
// and therefore resized every pane sharing that row or column. Here a split
// divides ONLY the selected pane, exactly like tmux/i3 — the rest of the layout
// is untouched.
//
// Everything in this module is pure. The tree never carries React state and
// never generates its own ids (callers pass them in), so the whole layout
// algebra is testable without a renderer.

/** `direction` uses flexbox meaning: "row" places the two children side by
 *  side (a vertical divider — "split right"), "column" stacks them (a
 *  horizontal divider — "split below"). */
export type SplitNode =
  | { kind: "leaf"; id: string; terminalId: string | null }
  | {
      kind: "split";
      id: string;
      direction: "row" | "column";
      /** Fraction of the parent given to `first`, in (0, 1). */
      ratio: number;
      first: SplitNode;
      second: SplitNode;
    };

/** Panes are capped at what the old 5x5 grid allowed, so a layout can't grow
 *  unbounded through repeated splits. */
export const MAX_SPLIT_LEAVES = 25;
/** Guards the recursive validator and rendering against a pathological tree
 *  (hand-edited config, or a bug). 25 leaves need at most 24 levels in the
 *  fully-degenerate case; this is that bound. */
export const MAX_SPLIT_DEPTH = 24;
/** Smallest share a pane may be shrunk to by dragging a divider. */
export const MIN_SPLIT_PANE_FRACTION = 0.18;

export interface Rect {
  /** All values are percentages of the pane container, 0-100. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LeafRect {
  leafId: string;
  terminalId: string | null;
  rect: Rect;
}

export interface DividerRect {
  splitId: string;
  direction: "row" | "column";
  /** The divider's own line: for a "row" split this is a vertical line at
   *  `left`, spanning `top`..`top+height`. */
  rect: Rect;
  /** The area the split governs. Dragging converts pixels to a ratio against
   *  THIS box, not the whole container — otherwise a divider nested inside a
   *  half-width pane would move at twice the pointer's speed. */
  bounds: Rect;
}

export function leaf(id: string, terminalId: string | null = null): SplitNode {
  return { kind: "leaf", id, terminalId };
}

export function isLeaf(node: SplitNode): node is Extract<SplitNode, { kind: "leaf" }> {
  return node.kind === "leaf";
}

export function leaves(node: SplitNode): Array<Extract<SplitNode, { kind: "leaf" }>> {
  if (isLeaf(node)) return [node];
  return [...leaves(node.first), ...leaves(node.second)];
}

export function leafCount(node: SplitNode): number {
  return isLeaf(node) ? 1 : leafCount(node.first) + leafCount(node.second);
}

export function treeDepth(node: SplitNode): number {
  return isLeaf(node) ? 1 : 1 + Math.max(treeDepth(node.first), treeDepth(node.second));
}

/** Every terminal id placed in the tree, in visual order. */
export function assignedTerminalIds(node: SplitNode): string[] {
  return leaves(node)
    .map((l) => l.terminalId)
    .filter((id): id is string => !!id);
}

export function findLeafByTerminal(
  node: SplitNode,
  terminalId: string,
): Extract<SplitNode, { kind: "leaf" }> | null {
  return leaves(node).find((l) => l.terminalId === terminalId) ?? null;
}

/** Structural map over leaves; returns the same reference when nothing
 *  changed, so React can skip re-rendering an untouched subtree. */
function mapLeaves(
  node: SplitNode,
  fn: (l: Extract<SplitNode, { kind: "leaf" }>) => SplitNode,
): SplitNode {
  if (isLeaf(node)) return fn(node);
  const first = mapLeaves(node.first, fn);
  const second = mapLeaves(node.second, fn);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Replace a leaf with a split of [that leaf, a new empty leaf]. Only this
 *  pane's area is divided — siblings keep their size, which is the whole point
 *  of the tree over the old grid. */
export function splitLeaf(
  tree: SplitNode,
  leafId: string,
  direction: "row" | "column",
  newSplitId: string,
  newLeafId: string,
): SplitNode {
  if (leafCount(tree) >= MAX_SPLIT_LEAVES) return tree;
  return mapLeaves(tree, (l) =>
    l.id === leafId
      ? {
          kind: "split",
          id: newSplitId,
          direction,
          ratio: 0.5,
          first: l,
          second: leaf(newLeafId),
        }
      : l,
  );
}

/** Drop a leaf; its sibling takes over the parent's whole area. Removing the
 *  last leaf leaves an empty root rather than an invalid empty tree. */
export function removeLeaf(tree: SplitNode, leafId: string): SplitNode {
  if (isLeaf(tree)) {
    return tree.id === leafId ? { ...tree, terminalId: null } : tree;
  }
  if (isLeaf(tree.first) && tree.first.id === leafId) return tree.second;
  if (isLeaf(tree.second) && tree.second.id === leafId) return tree.first;
  const first = removeLeaf(tree.first, leafId);
  const second = removeLeaf(tree.second, leafId);
  if (first === tree.first && second === tree.second) return tree;
  return { ...tree, first, second };
}

/** Clear whichever leaf holds this terminal, collapsing its split. */
export function removeTerminal(tree: SplitNode, terminalId: string): SplitNode {
  const target = findLeafByTerminal(tree, terminalId);
  return target ? removeLeaf(tree, target.id) : tree;
}

/** Put a terminal in a leaf. A terminal can only occupy one pane, so it is
 *  cleared from any other leaf first — otherwise two panes would drive the
 *  same PTY. */
export function assignTerminal(
  tree: SplitNode,
  leafId: string,
  terminalId: string | null,
): SplitNode {
  return mapLeaves(tree, (l) => {
    if (l.id === leafId) {
      return l.terminalId === terminalId ? l : { ...l, terminalId };
    }
    if (terminalId && l.terminalId === terminalId) return { ...l, terminalId: null };
    return l;
  });
}

export function resizeSplit(tree: SplitNode, splitId: string, ratio: number): SplitNode {
  const clamped = Math.max(
    MIN_SPLIT_PANE_FRACTION,
    Math.min(1 - MIN_SPLIT_PANE_FRACTION, ratio),
  );
  const walk = (node: SplitNode): SplitNode => {
    if (isLeaf(node)) return node;
    if (node.id === splitId) {
      return node.ratio === clamped ? node : { ...node, ratio: clamped };
    }
    const first = walk(node.first);
    const second = walk(node.second);
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return walk(tree);
}

/** Reconcile a tree with the tabs that actually exist: drop unknown and
 *  duplicated terminal ids, collapse splits whose subtree became entirely
 *  empty, and guarantee at least one occupied pane. Mirrors what the old
 *  normalizeSplitLayoutForTabs did for the grid. */
export function normalizeTreeForTabs(
  tree: SplitNode | undefined,
  tabIds: ReadonlySet<string>,
  fallbackId: string | null,
  newLeafId: string,
): SplitNode {
  const fallback = fallbackId && tabIds.has(fallbackId) ? fallbackId : null;
  if (!tree) return leaf(newLeafId, fallback);

  const seen = new Set<string>();
  const cleaned = mapLeaves(tree, (l) => {
    const id = l.terminalId;
    if (!id || !tabIds.has(id) || seen.has(id)) {
      return l.terminalId === null ? l : { ...l, terminalId: null };
    }
    seen.add(id);
    return l;
  });

  // Collapse a split only when NOTHING inside it is occupied — the tree
  // equivalent of the old grid pruning an entirely empty row or column.
  //
  // A single empty pane beside an occupied one is deliberate: it is what a
  // fresh split produces, and what remains when a terminal is closed. It
  // renders as the fillable "Empty pane" placeholder, so collapsing it would
  // undo the user's split the moment they made it.
  const collapse = (node: SplitNode): SplitNode => {
    if (isLeaf(node)) return node;
    const first = collapse(node.first);
    const second = collapse(node.second);
    if (
      assignedTerminalIds(first).length === 0 &&
      assignedTerminalIds(second).length === 0
    ) {
      return leaves(first)[0];
    }
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  const collapsed = collapse(cleaned);

  if (assignedTerminalIds(collapsed).length === 0 && fallback) {
    const first = leaves(collapsed)[0];
    return assignTerminal(collapsed, first.id, fallback);
  }
  return collapsed;
}

/** A layout worth persisting, or undefined for "no split" (a lone pane).
 *  Matches the old compactSplitLayout contract: absence means single-view. */
export function compactTree(tree: SplitNode): SplitNode | undefined {
  if (isLeaf(tree)) return undefined;
  return assignedTerminalIds(tree).length === 0 ? undefined : tree;
}

export function singleLeafTree(leafId: string, terminalId: string | null): SplitNode {
  return leaf(leafId, terminalId);
}

/** Geometry for every pane, as percentages of the container. Rendering uses
 *  this to place panes as absolutely-positioned FLAT siblings: nesting the DOM
 *  to match the tree would change each TerminalView's position in the React
 *  tree on every reshape and remount it (losing the terminal's view). */
export function layoutRects(
  tree: SplitNode,
  bounds: Rect = { left: 0, top: 0, width: 100, height: 100 },
): LeafRect[] {
  if (isLeaf(tree)) {
    return [{ leafId: tree.id, terminalId: tree.terminalId, rect: bounds }];
  }
  const [a, b] = splitBounds(tree, bounds);
  return [...layoutRects(tree.first, a), ...layoutRects(tree.second, b)];
}

function splitBounds(
  node: Extract<SplitNode, { kind: "split" }>,
  bounds: Rect,
): [Rect, Rect] {
  if (node.direction === "row") {
    const w = bounds.width * node.ratio;
    return [
      { ...bounds, width: w },
      { ...bounds, left: bounds.left + w, width: bounds.width - w },
    ];
  }
  const h = bounds.height * node.ratio;
  return [
    { ...bounds, height: h },
    { ...bounds, top: bounds.top + h, height: bounds.height - h },
  ];
}

/** One draggable line per split, positioned on the boundary between its two
 *  children. */
export function dividerRects(
  tree: SplitNode,
  bounds: Rect = { left: 0, top: 0, width: 100, height: 100 },
): DividerRect[] {
  if (isLeaf(tree)) return [];
  const [a, b] = splitBounds(tree, bounds);
  const line: Rect =
    tree.direction === "row"
      ? { left: bounds.left + a.width, top: bounds.top, width: 0, height: bounds.height }
      : { left: bounds.left, top: bounds.top + a.height, width: bounds.width, height: 0 };
  return [
    { splitId: tree.id, direction: tree.direction, rect: line, bounds },
    ...dividerRects(tree.first, a),
    ...dividerRects(tree.second, b),
  ];
}

/** The pane a directional move lands on, or null at the edge. Works off the
 *  rendered rectangles rather than tree structure, so it behaves the way the
 *  layout looks: candidates must lie in the requested direction and overlap on
 *  the perpendicular axis; nearest edge wins, ties broken by centre distance. */
export function focusDirection(
  tree: SplitNode,
  fromLeafId: string,
  direction: "left" | "right" | "up" | "down",
): string | null {
  const rects = layoutRects(tree);
  const current = rects.find((r) => r.leafId === fromLeafId);
  if (!current) return null;
  const c = current.rect;
  const cMidX = c.left + c.width / 2;
  const cMidY = c.top + c.height / 2;

  const EPSILON = 0.01; // percentage points; guards float drift on exact edges
  const candidates = rects.filter((r) => {
    if (r.leafId === fromLeafId) return false;
    const t = r.rect;
    if (direction === "left") {
      return t.left + t.width <= c.left + EPSILON && overlaps(t.top, t.height, c.top, c.height);
    }
    if (direction === "right") {
      return t.left >= c.left + c.width - EPSILON && overlaps(t.top, t.height, c.top, c.height);
    }
    if (direction === "up") {
      return t.top + t.height <= c.top + EPSILON && overlaps(t.left, t.width, c.left, c.width);
    }
    return t.top >= c.top + c.height - EPSILON && overlaps(t.left, t.width, c.left, c.width);
  });
  if (candidates.length === 0) return null;

  const gap = (r: Rect): number => {
    if (direction === "left") return c.left - (r.left + r.width);
    if (direction === "right") return r.left - (c.left + c.width);
    if (direction === "up") return c.top - (r.top + r.height);
    return r.top - (c.top + c.height);
  };
  const cross = (r: Rect): number =>
    direction === "left" || direction === "right"
      ? Math.abs(r.top + r.height / 2 - cMidY)
      : Math.abs(r.left + r.width / 2 - cMidX);

  return candidates.sort(
    (x, y) => gap(x.rect) - gap(y.rect) || cross(x.rect) - cross(y.rect),
  )[0].leafId;
}

function overlaps(aStart: number, aSize: number, bStart: number, bSize: number): boolean {
  return aStart < bStart + bSize - 0.01 && bStart < aStart + aSize - 0.01;
}

/** The legacy flat grid, for migrating configs written before the tree. */
export interface LegacySplitLayout {
  rows: number;
  cols: number;
  rowFr: number[];
  colFr: number[];
  cells: (string | null)[];
  activeCell: number;
}

/** Convert a rows x cols grid into an equivalent tree: a column split over the
 *  rows, each row a row split over its cells, with the original fr values as
 *  ratios.
 *
 *  Ids are derived from grid position rather than generated, which makes the
 *  conversion IDEMPOTENT: the same legacy layout always yields the same ids.
 *  That matters because migration runs on every read until the first save
 *  rewrites the project as a tree — with fresh ids each time, a remembered
 *  focused-pane id would never match the next tree and pane navigation would
 *  silently do nothing. */
export function treeFromLegacyLayout(layout: LegacySplitLayout): SplitNode {
  return balancedChain(
    layout.rowFr.slice(0, layout.rows),
    (row) =>
      balancedChain(
        layout.colFr.slice(0, layout.cols),
        (col) => leaf(`mig-r${row}c${col}`, layout.cells[row * layout.cols + col] ?? null),
        "row",
        (index) => `mig-r${row}s${index}`,
      ),
    "column",
    (index) => `mig-s${index}`,
  );
}

/** Right-leaning chain of binary splits whose ratios reproduce the original
 *  track proportions: each node gives its first child `values[i] / rest`. */
function balancedChain(
  values: number[],
  build: (index: number) => SplitNode,
  direction: "row" | "column",
  idAt: (index: number) => string,
): SplitNode {
  const sizes = values.length > 0 ? values : [1];
  const chain = (index: number, remaining: number): SplitNode => {
    if (index === sizes.length - 1) return build(index);
    const size = sizes[index] > 0 ? sizes[index] : 1;
    const ratio = remaining > 0 ? size / remaining : 0.5;
    return {
      kind: "split",
      id: idAt(index),
      direction,
      ratio: Math.max(MIN_SPLIT_PANE_FRACTION, Math.min(1 - MIN_SPLIT_PANE_FRACTION, ratio)),
      first: build(index),
      second: chain(index + 1, remaining - size),
    };
  };
  return chain(
    0,
    sizes.reduce((sum, v) => sum + (v > 0 ? v : 1), 0),
  );
}

/** Shape check for data coming off disk or across IPC. */
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
