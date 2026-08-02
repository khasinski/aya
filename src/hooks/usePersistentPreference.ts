import { useCallback, useState } from "react";

/** How a preference value maps to/from its localStorage string. `parse` only
 *  ever receives a present value; a missing key (or any thrown error) yields
 *  `fallback`. Define codecs at module scope so the returned setter is stable. */
export interface PreferenceCodec<T> {
  fallback: T;
  parse: (raw: string) => T;
  serialize: (value: T) => string;
}

/** State backed by localStorage. Replaces the repeated readX/useState/updateX
 *  triples: the returned setter writes through to storage (ignoring failures in
 *  embedded contexts where localStorage is unavailable). */
export function usePersistentPreference<T>(
  key: string,
  codec: PreferenceCodec<T>,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? codec.fallback : codec.parse(raw);
    } catch {
      return codec.fallback;
    }
  });
  const setPreference = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, codec.serialize(next));
      } catch {
        /* localStorage can be unavailable in odd embedded contexts */
      }
    },
    [key, codec],
  );
  return [value, setPreference];
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
