// Omarchy theme integration (Linux). Omarchy publishes the active theme as a
// flat, semantic colors.toml under ~/.local/state/omarchy/current/theme/ (a
// symlink it relinks on `omarchy-theme-set`), with the theme name in a sibling
// theme.name. We read that palette and let the renderer skin BOTH the app chrome
// and the terminal from it (see src/theme-skin.ts), and watch for switches so
// Aya re-themes live like every other Omarchy-aware app.
//
// Desktop/Linux only and fully opt-in: off Linux, or with no Omarchy install,
// everything here reports "unavailable" and Aya's built-in themes are untouched.

import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OmarchyPalette, OmarchyStatus, OmarchyTheme } from "./types";

const OMARCHY_STATE_DIR = path.join(
  os.homedir(),
  ".local",
  "state",
  "omarchy",
  "current",
);
const THEME_DIR = path.join(OMARCHY_STATE_DIR, "theme");
export const OMARCHY_COLORS_FILE = path.join(THEME_DIR, "colors.toml");
const OMARCHY_LIGHT_MODE_FILE = path.join(THEME_DIR, "light.mode");
const OMARCHY_THEME_NAME_FILE = path.join(OMARCHY_STATE_DIR, "theme.name");

/** snake_case colors.toml key -> camelCase OmarchyPalette field. */
const FIELD_MAP: Record<string, keyof OmarchyPalette> = {
  accent: "accent",
  selection: "selection",
  muted: "muted",
  background: "background",
  dark_background: "darkBackground",
  darker_background: "darkerBackground",
  lighter_background: "lighterBackground",
  foreground: "foreground",
  dark_foreground: "darkForeground",
  light_foreground: "lightForeground",
  bright_foreground: "brightForeground",
  red: "red",
  yellow: "yellow",
  orange: "orange",
  green: "green",
  cyan: "cyan",
  blue: "blue",
  magenta: "magenta",
  brown: "brown",
  bright_red: "brightRed",
  bright_yellow: "brightYellow",
  bright_green: "brightGreen",
  bright_cyan: "brightCyan",
  bright_blue: "brightBlue",
  bright_magenta: "brightMagenta",
};

/** Parse a colors.toml (flat `key = "value"`). Pure and exported for tests.
 *  `fallbackMode` is used only when the file names no mode - callers derive it
 *  from a sibling `light.mode` file. Returns null when the essentials
 *  (background/foreground/accent) are absent - a file we can't skin from. */
export function parseOmarchyColors(
  toml: string,
  fallbackMode: "dark" | "light" = "dark",
): OmarchyPalette | null {
  const kv = new Map<string, string>();
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    kv.set(m[1], val);
  }

  const background = kv.get("background");
  const foreground = kv.get("foreground");
  const accent = kv.get("accent");
  if (!background || !foreground || !accent) return null;

  const modeKey = kv.get("mode") ?? kv.get("theme_type");
  const mode: "dark" | "light" =
    modeKey === "light" ? "light" : modeKey === "dark" ? "dark" : fallbackMode;

  const palette: OmarchyPalette = { mode, background, foreground, accent };
  for (const [tomlKey, field] of Object.entries(FIELD_MAP)) {
    const v = kv.get(tomlKey);
    if (v) (palette[field] as string) = v;
  }
  return palette;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** True when Omarchy is installed with an active theme we can read. */
export async function omarchyAvailable(): Promise<boolean> {
  return exists(OMARCHY_COLORS_FILE);
}

/** The current Omarchy theme (name + palette), or null when unavailable. */
export async function readOmarchyTheme(): Promise<OmarchyTheme | null> {
  let toml: string;
  try {
    toml = await fs.readFile(OMARCHY_COLORS_FILE, "utf8");
  } catch {
    return null;
  }
  const fallbackMode = (await exists(OMARCHY_LIGHT_MODE_FILE)) ? "light" : "dark";
  const palette = parseOmarchyColors(toml, fallbackMode);
  if (!palette) return null;
  let name = "";
  try {
    name = (await fs.readFile(OMARCHY_THEME_NAME_FILE, "utf8")).trim();
  } catch {
    name = "";
  }
  return { name, palette };
}

export async function readOmarchyStatus(): Promise<OmarchyStatus> {
  const theme = await readOmarchyTheme();
  return {
    available: theme !== null,
    themeName: theme && theme.name ? theme.name : null,
  };
}

/** Watch for `omarchy-theme-set` (the current/ symlink and theme.name change).
 *  Debounced; returns an unwatch fn. A no-op if Omarchy isn't present. */
export function watchOmarchyTheme(onChange: () => void): () => void {
  let watcher: fsSync.FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = fsSync.watch(OMARCHY_STATE_DIR, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    });
  } catch {
    // Omarchy not installed (dir absent): nothing to watch.
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
