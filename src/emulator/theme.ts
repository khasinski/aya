// Authentic built-in themes for the emulator, copied from electron/themes.ts
// (which is main-process only and can't be imported by the renderer). Only the
// default "Aya Dark" is needed to render; Solarized Dark is included so the
// Settings theme list looks populated in screenshots.

import type { Theme, ThemesFile } from "../types";

const AYA_DARK: Theme = {
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

const SOLARIZED_DARK: Theme = {
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

export const EMULATOR_THEMES: ThemesFile = {
  themes: [AYA_DARK, SOLARIZED_DARK],
  activeId: "aya-dark",
};
