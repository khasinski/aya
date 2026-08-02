import { useRef } from "react";

/** Keep the previous identity of a derived value when its contents are
 *  unchanged per `same`. Derived collections get rebuilt whenever their
 *  useMemo inputs change identity (e.g. the terminals map on any status
 *  flip); when the rebuild produced equal contents, handing children the OLD
 *  identity keeps their React.memo warm. The ref write during render is the
 *  standard memo-cache escape hatch: idempotent for a given `next`. */
export function useStable<T>(next: T, same: (a: T, b: T) => boolean): T {
  const ref = useRef(next);
  if (ref.current !== next) {
    if (same(ref.current, next)) return ref.current;
    ref.current = next;
  }
  return ref.current;
}
