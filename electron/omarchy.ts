// Omarchy theme integration (Linux). Omarchy publishes the active theme as a flat
// colors.toml under ~/.local/state/omarchy/current/theme/ (a symlink it relinks on
// `omarchy-theme-set`); we skin from it (src/theme-skin.ts) and watch for switches.

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

/** Unwrap a TOML scalar: quoted span when quoted, else drop a trailing
 *  ` # comment`. A leading '#' is kept - that is a hex color, not a comment. */
function tomlScalar(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trim();
}

/** CSS named colors Omarchy palettes plausibly use. A whitelist, not
 *  `[a-zA-Z]+`, which would admit "mauve"/"currentColor" that neither sink resolves. */
const NAMED_COLORS = new Set([
  "black", "silver", "gray", "grey", "white", "maroon", "red", "purple",
  "fuchsia", "magenta", "green", "lime", "olive", "yellow", "navy", "blue",
  "teal", "aqua", "cyan", "orange", "brown", "pink", "violet", "indigo",
  "gold", "beige", "ivory", "khaki", "salmon", "coral", "tan", "turquoise",
  "lavender", "plum", "orchid", "crimson", "tomato", "chocolate", "rebeccapurple",
]);

/** Hex in the lengths CSS defines - 3, 4, 6 or 8 digits; xterm and CSSOM both
 *  drop a 5- or 7-digit value. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_RE = /^(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^()]*\)$/;

/** Values CSSOM and xterm can resolve; anything else is dropped at the parse
 *  boundary rather than silently discarded two layers down. */
function isColor(value: string): boolean {
  return (
    HEX_RE.test(value) ||
    FUNCTIONAL_RE.test(value) ||
    NAMED_COLORS.has(value.toLowerCase())
  );
}

/** Parse a colors.toml. `fallbackMode` applies only when the file names no mode.
 *  Null when background/foreground/accent are absent or unusable. */
export function parseOmarchyColors(
  toml: string,
  fallbackMode: "dark" | "light" = "dark",
): OmarchyPalette | null {
  /** Tables a palette may nest values under. Matched on the LAST path segment,
   *  since `[colors.primary]` is the canonical Alacritty spelling. */
  const NESTED_SECTIONS = new Set(["primary", "colors", "palette", "normal"]);

  // Separate maps so `[bright] red` cannot last-wins over top-level `red`: a
  // table key is taken from the FIRST table offering it, top level always wins.
  const top = new Map<string, string>();
  const nested = new Map<string, string>();
  let section = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    // Blank and '#' lines need no guard: neither regex below can match one.
    const header = /^\[+\s*([^\]]*?)\s*\]+$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = tomlScalar(rawValue);
    if (!section) {
      top.set(key, value);
      continue;
    }
    const leaf = section.slice(section.lastIndexOf(".") + 1);
    if (value && NESTED_SECTIONS.has(leaf) && !nested.has(key)) {
      nested.set(key, value);
    }
  }

  // An empty top-level value is no value: fall through to the tables.
  const lookup = (key: string): string | undefined =>
    top.get(key) || nested.get(key);
  const color = (key: string): string | undefined => {
    const value = lookup(key);
    return value && isColor(value) ? value : undefined;
  };

  const background = color("background");
  const foreground = color("foreground");
  const accent = color("accent");
  if (!background || !foreground || !accent) return null;

  // Same lookup as the colors: a sectioned file namespaces `mode` too.
  const modeKey = lookup("mode") ?? lookup("theme_type");
  const mode: "dark" | "light" =
    modeKey === "light" ? "light" : modeKey === "dark" ? "dark" : fallbackMode;

  const palette: OmarchyPalette = { mode, background, foreground, accent };
  for (const [tomlKey, field] of Object.entries(FIELD_MAP)) {
    // Same gate as the essentials: drop unusable optionals so theme-skin falls back.
    const v = color(tomlKey);
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

/** True when Omarchy has an active theme we can skin from - file existence is
 *  not enough, the colors.toml must parse into a usable palette. */
export async function omarchyAvailable(): Promise<boolean> {
  return (await readOmarchyTheme()) !== null;
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
    // The try/catch only covers synchronous construction; an unhandled later
    // "error" would be an uncaught exception in the main process.
    watcher.on("error", () => {
      watcher?.close();
      watcher = null;
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
