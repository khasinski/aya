import { useCallback, useState } from "react";
import type { PreferenceCodec } from "../preference-codecs";
export { boolPreference, enumPreference, type PreferenceCodec } from "../preference-codecs";

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
