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

/** How many lines of one file the diff view renders before a "Show more lines" button, and how many each press adds. */
export const DIFF_LINES_PER_FILE = 2000;

export type DiffRow = { kind: "line"; index: number } | { kind: "more"; fileStart: number; hidden: number };

/** The rows the diff view renders: each file (from its `diff --git` header; lines before the first header count as
 *  one file) shows its first `shown.get(fileStart) ?? DIFF_LINES_PER_FILE` lines, then one "more" row for the rest.
 *  A file's header is always shown, so a jump to it still lands. */
export function cappedDiffRows(lines: readonly string[], shown: ReadonlyMap<number, number> = new Map(), cap = DIFF_LINES_PER_FILE): DiffRow[] {
  const rows: DiffRow[] = [];
  let fileStart = 0, inFile = 0, hidden = 0;
  const flush = () => { if (hidden) rows.push({ kind: "more", fileStart, hidden }); hidden = 0; };
  lines.forEach((line, index) => {
    if (index > 0 && line.startsWith("diff --git")) { flush(); fileStart = index; inFile = 0; }
    if (inFile++ < Math.max(1, shown.get(fileStart) ?? cap)) rows.push({ kind: "line", index });
    else hidden++;
  });
  flush();
  return rows;
}
