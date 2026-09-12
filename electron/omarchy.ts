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

/** Unwrap a TOML scalar: take the quoted span when quoted, otherwise drop a
 *  trailing ` # comment`. Both matter because the result is handed to CSSOM and
 *  to xterm, and BOTH of those discard an unparsable color in silence - so
 *  `accent = "#f00" # brand` used to skin nothing while Settings still claimed
 *  the theme was being followed. A leading '#' is kept: that is a hex color,
 *  not a comment. */
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

/** CSS named colors Omarchy palettes plausibly use. An open `[a-zA-Z]+` branch
 *  would accept "mauve", "notacolor" or "currentColor" - none of which either
 *  sink can resolve - which would leave exactly the silent discard this gate
 *  exists to prevent. Omarchy itself emits hex; the list is a courtesy. */
const NAMED_COLORS = new Set([
  "black", "silver", "gray", "grey", "white", "maroon", "red", "purple",
  "fuchsia", "magenta", "green", "lime", "olive", "yellow", "navy", "blue",
  "teal", "aqua", "cyan", "orange", "brown", "pink", "violet", "indigo",
  "gold", "beige", "ivory", "khaki", "salmon", "coral", "tan", "turquoise",
  "lavender", "plum", "orchid", "crimson", "tomato", "chocolate", "rebeccapurple",
]);

/** Hex in the lengths CSS actually defines - 3, 4, 6 or 8 digits. A 5- or
 *  7-digit value looks hex-ish but resolves nowhere: xterm's parser switches on
 *  those exact lengths and CSSOM drops the declaration. */
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNCTIONAL_RE = /^(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^()]*\)$/;

/** Values we are willing to hand to CSSOM and xterm. Anything else is dropped
 *  at the parse boundary rather than discarded silently two layers down. */
function isColor(value: string): boolean {
  return (
    HEX_RE.test(value) ||
    FUNCTIONAL_RE.test(value) ||
    NAMED_COLORS.has(value.toLowerCase())
  );
}

/** Parse a colors.toml (flat `key = "value"`). Pure and exported for tests.
 *  `fallbackMode` is used only when the file names no mode - callers derive it
 *  from a sibling `light.mode` file. Returns null when the essentials
 *  (background/foreground/accent) are absent OR are not usable colors - either
 *  way it is a file we can't skin from. */
export function parseOmarchyColors(
  toml: string,
  fallbackMode: "dark" | "light" = "dark",
): OmarchyPalette | null {
  /** Tables a palette plausibly nests its values under. Matched on the LAST
   *  segment of the table path, because `[colors.primary]` is the canonical
   *  Alacritty spelling and a whole-path whitelist would miss it - the old flat
   *  parser resolved such a file, so anything narrower is a regression that
   *  silently reports Omarchy unavailable. */
  const NESTED_SECTIONS = new Set(["primary", "colors", "palette", "normal"]);

  // Two views, filled as we read: keys written at the top level, and keys
  // written under one of the tables above. Sectioned keys are kept rather than
  // discarded (a file whose essentials live under a table is still skinnable),
  // but they stay in their own map so `[bright] red` can never overwrite the
  // top-level `red` by last-wins. A table key is taken from the FIRST table
  // that offers it; a top-level key always wins outright.
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

  // An empty top-level value is no value: fall through to the tables, exactly
  // as the previous scan did.
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

  // Through the same lookup as the colors: a sectioned file is exactly the kind
  // that namespaces its keys, so reading `mode` only at the top level would
  // lose the declared mode on the one shape the namespacing exists for.
  const modeKey = lookup("mode") ?? lookup("theme_type");
  const mode: "dark" | "light" =
    modeKey === "light" ? "light" : modeKey === "dark" ? "dark" : fallbackMode;

  const palette: OmarchyPalette = { mode, background, foreground, accent };
  for (const [tomlKey, field] of Object.entries(FIELD_MAP)) {
    // Same gate as the essentials: an unusable optional color is dropped, so
    // theme-skin falls back to a color that works instead of emitting one that
    // CSSOM and xterm will each quietly throw away.
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

/** True when Omarchy is installed with an active theme we can actually skin
 *  from. File existence is not enough: a colors.toml we cannot parse into a
 *  usable palette would have us claim a skin that neither CSSOM nor xterm
 *  applies. */
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
    // The try/catch above only covers the SYNCHRONOUS construction. A watch
    // that dies later (the state dir removed, an inotify watch dropped) emits
    // "error", and an unhandled "error" on an EventEmitter is thrown as an
    // uncaught exception - here, in the main process. Degrade to "no live
    // re-skin" instead.
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
