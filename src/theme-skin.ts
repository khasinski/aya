// One semantic palette -> the whole app's look. A "skin" (today: the active
// Omarchy theme) is an OmarchyPalette; these two pure functions turn it into the
// app-chrome CSS variables and the terminal ThemeColors, so a single source
// themes both surfaces consistently.
//
// Chrome tiers are expressed as CSS `color-mix(in oklab, ...)` against the
// palette's own background/foreground, so any palette produces sensible
// secondary/tertiary shades regardless of which optional tiers it defines - and
// because the result is applied as inline custom properties, any token stays
// overridable without touching a stylesheet. Terminal colors, by contrast, must
// be concrete (xterm parses them itself), so they come straight from palette
// hex with plain fallbacks.

import type { OmarchyPalette, Preset, Theme, ThemeColors } from "./types";

/** `color-mix(in oklab, base pct%, toward)` — pct% of `base`, the rest `toward`. */
function mix(base: string, pct: number, toward: string): string {
  return `color-mix(in oklab, ${base} ${pct}%, ${toward})`;
}

/** Map a palette to the app-chrome custom properties (the source tokens in
 *  src/styles/armillary.css). The returned keys are exactly the properties to
 *  set on :root (and to remove when clearing the skin). */
export function paletteToChromeVars(p: OmarchyPalette): Record<string, string> {
  const bg = p.background;
  const fg = p.foreground;
  const accent = p.accent;
  const muted = p.muted ?? mix(fg, 55, bg);
  return {
    "--bg": bg,
    "--bg-secondary": mix(bg, 92, fg),
    "--bg-tertiary": mix(bg, 86, fg),
    "--bg-code": mix(bg, 90, fg),
    "--fg-primary": fg,
    "--fg-secondary": mix(fg, 82, bg),
    "--fg-tertiary": muted,
    "--border": mix(bg, 62, muted),
    "--border-strong": muted,
    "--accent": accent,
    "--accent-hover": mix(accent, 82, fg),
    // Only the WARNING callout pair has a reader (overrides.css); the info,
    // success and error triplets were computed and applied for nothing.
    "--callout-warning-bg": mix(p.yellow ?? accent, 15, bg),
    "--callout-warning-fg": p.yellow ?? accent,
  };
}

/** Map a palette to terminal colors (xterm ITheme superset). All concrete hex -
 *  xterm can't resolve color-mix() - with plain fallbacks for a partial palette
 *  (real Omarchy palettes fill every ANSI slot). */
export function paletteToThemeColors(p: OmarchyPalette): ThemeColors {
  return {
    background: p.background,
    foreground: p.foreground,
    cursor: p.accent,
    cursorAccent: p.background,
    selectionBackground:
      p.selection ?? p.muted ?? p.lighterBackground ?? p.darkBackground ?? p.background,
    black: p.darkerBackground ?? p.darkBackground ?? p.background,
    red: p.red ?? "#cc6666",
    green: p.green ?? "#b5bd68",
    yellow: p.yellow ?? "#f0c674",
    blue: p.blue ?? p.accent,
    magenta: p.magenta ?? "#b294bb",
    cyan: p.cyan ?? "#8abeb7",
    white: p.lightForeground ?? p.foreground,
    brightBlack: p.muted ?? p.darkForeground ?? p.foreground,
    brightRed: p.brightRed ?? p.red ?? "#cc6666",
    brightGreen: p.brightGreen ?? p.green ?? "#b5bd68",
    brightYellow: p.brightYellow ?? p.yellow ?? "#f0c674",
    brightBlue: p.brightBlue ?? p.blue ?? p.accent,
    brightMagenta: p.brightMagenta ?? p.magenta ?? "#b294bb",
    brightCyan: p.brightCyan ?? p.cyan ?? "#8abeb7",
    brightWhite: p.brightForeground ?? p.lightForeground ?? p.foreground,
  };
}

// Hard fallback used only if the themes file is somehow empty before boot
// resolves - matches AYA_DARK in electron/themes.ts.
const FALLBACK_THEME_COLORS: ThemeColors = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "rgba(88,166,255,0.3)",
  black: "#484f58",
  red: "#ff7b72",
  green: "#56d364",
  yellow: "#e3b341",
  blue: "#79c0ff",
  magenta: "#d2a8ff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#7ee787",
  brightYellow: "#f0ad4e",
  brightBlue: "#a5d6ff",
  brightMagenta: "#ffa657",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

export function resolveActiveTheme(themes: Theme[], activeThemeId: string) {
  const activeTheme = themes.find((t) => t.id === activeThemeId) ?? themes[0];
  const activeThemeColors: ThemeColors =
    activeTheme?.colors ?? FALLBACK_THEME_COLORS;
  return { activeTheme, activeThemeColors };
}

export function resolveActiveThemeId(themes: Theme[], activeThemeId: string): string {
  return themes.some((t) => t.id === activeThemeId)
    ? activeThemeId
    : (themes[0]?.id ?? "");
}

export function sweepPresetThemes(currentPresets: Preset[], nextThemes: Theme[]) {
  // Sweep presets for themeId references that point at themes no longer
  // in the list - otherwise presets.json keeps dangling pointers and the
  // Settings UI shows "Default" for them (because resolution falls back)
  // but the data on disk lies.
  const liveIds = new Set(nextThemes.map((t) => t.id));
  let dirty = false;
  const swept = currentPresets.map((p) => {
    if (p.themeId && !liveIds.has(p.themeId)) {
      dirty = true;
      const { themeId: _drop, ...rest } = p;
      void _drop;
      return rest;
    }
    return p;
  });
  return { swept, dirty };
}
