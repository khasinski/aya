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

import type { OmarchyPalette, ThemeColors } from "./types";

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
    "--fg-inverse": bg,
    "--border": mix(bg, 62, muted),
    "--border-strong": muted,
    "--border-focus": accent,
    "--accent": accent,
    "--accent-hover": mix(accent, 82, fg),
    // Dark-only token in armillary; harmless to set in light.
    "--heat-0": mix(bg, 92, fg),
    "--callout-info-bg": mix(p.blue ?? accent, 15, bg),
    "--callout-info-fg": p.blue ?? accent,
    "--callout-warning-bg": mix(p.yellow ?? accent, 15, bg),
    "--callout-warning-fg": p.yellow ?? accent,
    "--callout-success-bg": mix(p.green ?? accent, 15, bg),
    "--callout-success-fg": p.green ?? accent,
    "--callout-error-bg": mix(p.red ?? accent, 15, bg),
    "--callout-error-fg": p.red ?? accent,
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
