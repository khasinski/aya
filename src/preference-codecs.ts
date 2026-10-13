/** How a preference value maps to/from its localStorage string. `parse` only
 *  ever receives a present value; a missing key (or any thrown error) yields
 *  `fallback`. Define codecs at module scope so the returned setter is stable. */
export interface PreferenceCodec<T> {
  fallback: T;
  parse: (raw: string) => T;
  serialize: (value: T) => string;
}

/** Boolean stored as "1"/"0". `defaultTrue` controls the missing-key value (and
 *  matches the legacy `!== "0"` vs `=== "1"` read semantics). */
export function boolPreference(defaultTrue: boolean): PreferenceCodec<boolean> {
  return {
    fallback: defaultTrue,
    parse: defaultTrue ? (raw) => raw !== "0" : (raw) => raw === "1",
    serialize: (v) => (v ? "1" : "0"),
  };
}

/** String value restricted to a known set; anything else reads as `fallback`. */
export function enumPreference<T extends string>(
  values: readonly T[],
  fallback: T,
): PreferenceCodec<T> {
  const allowed = new Set<string>(values);
  return {
    fallback,
    parse: (raw) => (allowed.has(raw) ? (raw as T) : fallback),
    serialize: (v) => v,
  };
}
