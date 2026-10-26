/** Advance before every History-query decision, including too-short queries,
 * so responses from the preceding query can never repaint cleared results. */
export function beginHistorySearch(
  sequence: { current: number },
  query: string,
  minimumLength: number,
): { id: number; shouldSearch: boolean } {
  const id = ++sequence.current;
  return { id, shouldSearch: query.length >= minimumLength };
}
