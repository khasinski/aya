import { useEffect, useRef } from "react";
import {
  handleKeyDown,
  handleKeyUp,
  initialDoubleShiftState,
  type DoubleShiftState,
} from "../double-shift";

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
    let state: DoubleShiftState = { ...initialDoubleShiftState };
    const onKeyDown = (e: KeyboardEvent) => {
      state = handleKeyDown(state, e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const result = handleKeyUp(state, e, Date.now());
      state = result.state;
      if (result.triggered && enabledRef.current) onToggleRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);
}
