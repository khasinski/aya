// Terminal color themes.
//
// Internal representation matches xterm.js's `ITheme` so we can pass a theme
// straight into the terminal without conversion. We support importing two
// popular external formats:
//   1. iTerm2 `.itermcolors` (XML plist) — de facto standard on macOS
//   2. Windows Terminal JSON (scheme object) — clean schema, parses trivially
//
// Stored at ~/.aya/themes.json (or ~/.aya-dev/themes.json in dev) along with
// the user's active theme selection.

import { promises as fs } from "node:fs";
import * as plist from "plist";
import { writeFileAtomic } from "./atomic-write";
import { THEMES_FILE } from "./paths";

export interface ThemeColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
}

export interface ThemesFile {
  themes: Theme[];
  activeId: string;
}

// ----- Built-in themes -------------------------------------------------------

/** "Aya Dark" — the tuned palette from the design (TerminalView.tsx previously
 *  hard-coded this). Kept as the default and as the seed for new installs. */
export const AYA_DARK: Theme = {
  id: "aya-dark",
  name: "Aya Dark",
  colors: {
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
  },
};

export const SOLARIZED_DARK: Theme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  colors: {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "rgba(7,54,66,0.6)",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
};

export const TOKYO_NIGHT: Theme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  colors: {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "rgba(40,52,87,0.6)",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
};

export const DEFAULT_THEMES: readonly Theme[] = [
  AYA_DARK,
  SOLARIZED_DARK,
  TOKYO_NIGHT,
];

// ----- Persistence -----------------------------------------------------------

function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s);
}

function isColor(s: unknown): s is string {
  // Accept hex (#rrggbb / #rrggbbaa) and rgba(...) — the only forms we emit.
  return (
    isHexColor(s) ||
    (typeof s === "string" && /^rgba?\(/.test(s))
  );
}

function isThemeColors(x: unknown): x is ThemeColors {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  const required = [
    "background", "foreground", "cursor",
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue",
    "brightMagenta", "brightCyan", "brightWhite",
  ] as const;
  return required.every((k) => isColor(r[k]));
}

function isTheme(x: unknown): x is Theme {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    !!r.id &&
    typeof r.name === "string" &&
    isThemeColors(r.colors)
  );
}

export async function loadThemes(): Promise<ThemesFile> {
  try {
    const raw = await fs.readFile(THEMES_FILE, "utf-8");
    const data = JSON.parse(raw);
    const themes = Array.isArray(data?.themes)
      ? (data.themes as unknown[]).filter(isTheme)
      : [];
    if (themes.length === 0) {
      const seed: ThemesFile = {
        themes: [...DEFAULT_THEMES],
        activeId: AYA_DARK.id,
      };
      await saveThemes(seed);
      return seed;
    }
    const activeId =
      typeof data.activeId === "string" &&
      themes.some((t) => t.id === data.activeId)
        ? data.activeId
        : themes[0].id;
    return { themes, activeId };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const seed: ThemesFile = {
        themes: [...DEFAULT_THEMES],
        activeId: AYA_DARK.id,
      };
      await saveThemes(seed);
      return seed;
    }
    throw err;
  }
}

export async function saveThemes(file: ThemesFile): Promise<void> {
  const sanitized: ThemesFile = {
    themes: file.themes.filter(isTheme),
    activeId: file.activeId,
  };
  await writeFileAtomic(
    THEMES_FILE,
    JSON.stringify(sanitized, null, 2) + "\n",
  );
}

// ----- Parsers ---------------------------------------------------------------

function toHex(n: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped.toString(16).padStart(2, "0");
}

interface ItermColorDict {
  "Color Space"?: string;
  "Red Component"?: number;
  "Green Component"?: number;
  "Blue Component"?: number;
  "Alpha Component"?: number;
}

function colorFromItermDict(d: unknown): string | null {
  if (typeof d !== "object" || d === null) return null;
  const c = d as ItermColorDict;
  const r = c["Red Component"];
  const g = c["Green Component"];
  const b = c["Blue Component"];
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") {
    return null;
  }
  return `#${toHex(r * 255)}${toHex(g * 255)}${toHex(b * 255)}`;
}

export function parseItermColors(xml: string, fallbackName: string): Theme {
  const data = plist.parse(xml) as Record<string, unknown>;

  const ansi: string[] = [];
  for (let i = 0; i < 16; i++) {
    const c = colorFromItermDict(data[`Ansi ${i} Color`]);
    if (!c) {
      throw new Error(`iTerm2 theme is missing "Ansi ${i} Color"`);
    }
    ansi.push(c);
  }
  const bg = colorFromItermDict(data["Background Color"]);
  const fg = colorFromItermDict(data["Foreground Color"]);
  const cursor = colorFromItermDict(data["Cursor Color"]) ?? fg;
  if (!bg || !fg) {
    throw new Error("iTerm2 theme is missing Background or Foreground Color");
  }

  const selection = colorFromItermDict(data["Selection Color"]);

  return {
    id: makeImportedId(fallbackName),
    name: fallbackName,
    colors: {
      background: bg,
      foreground: fg,
      cursor: cursor ?? fg,
      cursorAccent: bg,
      selectionBackground: selection ?? undefined,
      black: ansi[0],
      red: ansi[1],
      green: ansi[2],
      yellow: ansi[3],
      blue: ansi[4],
      magenta: ansi[5],
      cyan: ansi[6],
      white: ansi[7],
      brightBlack: ansi[8],
      brightRed: ansi[9],
      brightGreen: ansi[10],
      brightYellow: ansi[11],
      brightBlue: ansi[12],
      brightMagenta: ansi[13],
      brightCyan: ansi[14],
      brightWhite: ansi[15],
    },
  };
}

/** Windows Terminal calls the magenta channels `purple` / `brightPurple`.
 *  Everything else lines up with xterm.js naming. */
export function parseWindowsTerminalJson(
  json: string,
  fallbackName: string,
): Theme {
  const data = JSON.parse(json) as Record<string, unknown>;
  const ck = (k: string): string => {
    const v = data[k];
    if (typeof v !== "string") {
      throw new Error(`Windows Terminal theme is missing field "${k}"`);
    }
    return v;
  };
  const opt = (k: string): string | undefined => {
    const v = data[k];
    return typeof v === "string" ? v : undefined;
  };
  const name =
    typeof data.name === "string" && data.name.trim() ? data.name : fallbackName;
  return {
    id: makeImportedId(name),
    name,
    colors: {
      background: ck("background"),
      foreground: ck("foreground"),
      cursor: opt("cursorColor") ?? ck("foreground"),
      cursorAccent: ck("background"),
      selectionBackground: opt("selectionBackground"),
      black: ck("black"),
      red: ck("red"),
      green: ck("green"),
      yellow: ck("yellow"),
      blue: ck("blue"),
      magenta: ck("purple"),
      cyan: ck("cyan"),
      white: ck("white"),
      brightBlack: ck("brightBlack"),
      brightRed: ck("brightRed"),
      brightGreen: ck("brightGreen"),
      brightYellow: ck("brightYellow"),
      brightBlue: ck("brightBlue"),
      brightMagenta: ck("brightPurple"),
      brightCyan: ck("brightCyan"),
      brightWhite: ck("brightWhite"),
    },
  };
}

/** Best-effort dispatch — try plist parse first since `.itermcolors` files
 *  often have no extension after download. */
export function parseTheme(content: string, sourceName: string): Theme {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<plist")) {
    return parseItermColors(content, sourceName);
  }
  return parseWindowsTerminalJson(content, sourceName);
}

function makeImportedId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Suffix with a short random so reimporting the same name doesn't collide.
  const tail = Math.random().toString(36).slice(2, 6);
  return `${slug || "imported"}-${tail}`;
}
