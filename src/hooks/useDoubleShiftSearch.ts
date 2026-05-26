import { useEffect, useRef } from "react";

interface Options {
  enabled: boolean;
  onToggle: () => void;
}

export function useDoubleShiftSearch({ enabled, onToggle }: Options): void {
  const enabledRef = useRef(enabled);
  const onToggleRef = useRef(onToggle);
  enabledRef.current = enabled;
  onToggleRef.current = onToggle;

  useEffect(() => {
    let lastShiftUp = 0;
    let chainActive = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Shift") chainActive = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      // No other modifiers — exclude Shift+Cmd, Shift+Ctrl, etc.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const now = Date.now();
      if (chainActive && now - lastShiftUp < 300) {
        chainActive = false;
        if (enabledRef.current) onToggleRef.current();
        return;
      }
      lastShiftUp = now;
      chainActive = true;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);
}
