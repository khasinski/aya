import type { ChromeStyle, LayoutMode } from "./types";

/** The window layout as the user sees it: one choice out of four. It is stored as two independent
 *  preferences (`aya:layout-mode`, `aya:chrome-style`), which renderers still read separately, so the
 *  stored keys stay as they are and this is the single place that maps between the two views. */
export type WindowLayout = "top" | "left" | "command-rail" | "command-rail-left";

export const WINDOW_LAYOUTS: ReadonlyArray<{
  id: WindowLayout;
  label: string;
  layoutMode: LayoutMode;
  chromeStyle: ChromeStyle;
}> = [
  { id: "top", label: "Projects on top", layoutMode: "classic", chromeStyle: "classic" },
  { id: "left", label: "Projects on left", layoutMode: "projects-left", chromeStyle: "classic" },
  { id: "command-rail", label: "Command Rail", layoutMode: "classic", chromeStyle: "command-rail" },
  { id: "command-rail-left", label: "Command Rail, projects left", layoutMode: "projects-left", chromeStyle: "command-rail" },
];

export function windowLayoutOf(layoutMode: LayoutMode, chromeStyle: ChromeStyle): WindowLayout {
  return (
    WINDOW_LAYOUTS.find((l) => l.layoutMode === layoutMode && l.chromeStyle === chromeStyle)?.id ?? "top"
  );
}

export function windowLayoutParts(layout: WindowLayout): { layoutMode: LayoutMode; chromeStyle: ChromeStyle } {
  const found = WINDOW_LAYOUTS.find((l) => l.id === layout) ?? WINDOW_LAYOUTS[0];
  return { layoutMode: found.layoutMode, chromeStyle: found.chromeStyle };
}
