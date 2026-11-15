export const MAX_SPLIT_LEAVES: number;
export const MAX_SPLIT_DEPTH: number;
export function isSplitNode(value: unknown, depth?: number): boolean;

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
