// Pure helper behind the status-bar "click a changed file → jump to it in the
// diff" behaviour. Kept separate from the React component so it can be unit
// tested without a DOM.

/** Zero-based line index of the `diff --git a/… b/<path>` header for `path` in
 *  a unified diff, or -1 if the file isn't present. Matches the b-side path so
 *  renames resolve to their new location. Returns -1 for an empty path.
 *
 *  The index is line-based (over `diff.split("\n")`), which is exactly how the
 *  diff view enumerates its rows, so the result doubles as the row to scroll to. */
export function diffFileLineIndex(diff: string, path: string): number {
  if (!path) return -1;
  const needle = ` b/${path}`;
  return diff
    .split("\n")
    .findIndex((line) => line.startsWith("diff --git") && line.includes(needle));
}
