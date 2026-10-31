import { useCallback, useEffect, useState } from "react";
import type { PreferenceCodec } from "../preference-codecs";
export { boolPreference, enumPreference, type PreferenceCodec } from "../preference-codecs";

/** State backed by localStorage. Replaces the repeated readX/useState/updateX
 *  triples: the returned setter writes through to storage (ignoring failures in
 *  embedded contexts where localStorage is unavailable), and a `storage` event
 *  from another Aya window updates this window's state in place. */
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
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return;
      try {
        setValue(
          event.newValue === null ? codec.fallback : codec.parse(event.newValue),
        );
      } catch {
        setValue(codec.fallback);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, codec]);
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
