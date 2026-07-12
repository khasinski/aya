// Identity-preserving equality for derived collections. App re-derives
// arrays/records from the `terminals` map on every status flip; when the
// derived CONTENTS are unchanged (e.g. a background project's terminal
// flipped, the active project's list is the same objects), reusing the
// previous identity keeps memoized children (Sidebar/TopBar) from
// re-rendering. Pure functions here; the useStable* hooks live in App.

/** Same length and same elements by reference (Object.is). */
export function sameArrayItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

/** Same key set and, per key, values equal by `sameValue` (default Object.is).
 *  Key ORDER is deliberately ignored: these records are keyed lookups, not
 *  ordered lists, and rebuild order can vary with map iteration. */
export function sameRecordValues<V>(
  a: Readonly<Record<string, V>>,
  b: Readonly<Record<string, V>>,
  sameValue: (x: V, y: V) => boolean = Object.is,
): boolean {
  if (a === b) return true;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!(key in b) || !sameValue(a[key], b[key])) return false;
  }
  return true;
}
