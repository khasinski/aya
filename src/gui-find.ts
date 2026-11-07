// Finding text in a Conversation GUI pane (Cmd+F). The matching is plain: case-insensitive, no regular expressions.

export interface TextMatch { start: number; length: number }

/** Every non-overlapping occurrence of `query` in `text`. An empty or whitespace-only query matches nothing. */
export function findTextMatches(text: string, query: string): TextMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  if (haystack.length !== text.length) return [];   // case folding changed the length: offsets would not line up
  const out: TextMatch[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
    out.push({ start: at, length: needle.length });
  }
  return out;
}

/** The match to show after Enter (forward) or Shift+Enter (backward), wrapping around. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** "3 of 12", "No results", or "" for an empty query. */
export function findStatus(query: string, current: number, count: number): string {
  if (!query.trim()) return "";
  return count === 0 ? "No results" : `${current + 1} of ${count}`;
}
