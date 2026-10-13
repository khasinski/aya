import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  paletteToChromeVars,
  paletteToThemeColors,
  resolveActiveTheme,
  resolveActiveThemeId,
  sweepPresetThemes,
} from "../theme-skin";
import type { Preset, Theme, ThemeColors } from "../types";

interface AppThemeOptions {
  appThemePreference: "system" | "light" | "dark" | "omarchy";
  themes: Theme[];
  activeThemeId: string;
  setThemes: Dispatch<SetStateAction<Theme[]>>;
  setActiveThemeId: Dispatch<SetStateAction<string>>;
  presetsRef: RefObject<Preset[]>;
  setPresets: Dispatch<SetStateAction<Preset[]>>;
}

export function useAppTheme({
  appThemePreference,
  themes,
  activeThemeId,
  setThemes,
  setActiveThemeId,
  presetsRef,
  setPresets,
}: AppThemeOptions) {
  // Terminal colors from the active skin (Omarchy), or null when no skin is on.
  // Takes precedence over the selected terminal theme, below the per-tab
  // override.
  const [skinThemeColors, setSkinThemeColors] = useState<ThemeColors | null>(
    null,
  );

  useEffect(() => {
    const root = document.documentElement;
    // "omarchy" is not a light/dark mode; the skin effect below owns data-theme
    // (it sets it to the Omarchy palette's own mode).
    if (appThemePreference === "omarchy") return;
    if (appThemePreference === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.dataset.theme = appThemePreference;
    }
  }, [appThemePreference]);

  // Omarchy skin: when selected, drive the app chrome (inline CSS vars over the
  // base light/dark tokens) AND the terminal (skinThemeColors) from the current
  // Omarchy palette, and re-apply live when the Omarchy theme is switched.
  // Leaving the mode removes the inline vars, restoring the built-in theme.
  useEffect(() => {
    if (appThemePreference !== "omarchy") {
      setSkinThemeColors(null);
      return;
    }
    const root = document.documentElement;
    let cancelled = false;
    let applied: string[] = [];
    // The ONE way out of "skinned": inline custom properties outrank every
    // stylesheet rule, so a branch that skips this leaves stale chrome.
    const clearSkin = () => {
      for (const key of applied) root.style.removeProperty(key);
      applied = [];
    };
    const apply = async () => {
      const theme = await window.aya.getOmarchyTheme();
      if (cancelled) return;
      if (!theme) {
        // Unskin, but KEEP the preference: a null here is often transient
        // (omarchy-theme-set relinks current/ mid-read), and persisting
        // "system" would lose the user's explicit choice permanently.
        clearSkin();
        root.removeAttribute("data-theme");
        setSkinThemeColors(null);
        return;
      }
      root.dataset.theme = theme.palette.mode;
      const vars = paletteToChromeVars(theme.palette);
      applied = Object.keys(vars);
      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
      setSkinThemeColors(paletteToThemeColors(theme.palette));
    };
    void apply();
    const unsubscribe = window.aya.onOmarchyThemeChange(() => void apply());
    return () => {
      cancelled = true;
      unsubscribe();
      clearSkin();
    };
  }, [appThemePreference]);

  const onSaveThemes = useCallback(
    async (nextThemes: Theme[], nextActiveId: string) => {
      const activeId = resolveActiveThemeId(nextThemes, nextActiveId);
      await window.aya.saveThemes({ themes: nextThemes, activeId });
      setThemes(nextThemes);
      setActiveThemeId(activeId);

      const { swept, dirty } = sweepPresetThemes(presetsRef.current, nextThemes);
      if (dirty) {
        await window.aya.savePresets(swept);
        setPresets(swept);
      }
    },
    [setThemes, setActiveThemeId, presetsRef, setPresets],
  );

  const onImportTheme = useCallback(async (): Promise<Theme | null> => {
    return window.aya.importTheme();
  }, []);

  const { activeTheme, activeThemeColors } = resolveActiveTheme(themes, activeThemeId);

  return { skinThemeColors, onSaveThemes, onImportTheme, activeTheme, activeThemeColors };
}
