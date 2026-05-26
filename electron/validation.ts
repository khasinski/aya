import type {
  ProjectConfig,
  SpawnRequest,
  Theme,
  ThemesFile,
  WorkingTab,
} from "./types";
import type { Preset } from "./presets";
import type { ThemeColors } from "./themes";
import { isPreset } from "./presets";

function fail(name: string, expected: string): never {
  throw new Error(`Invalid IPC payload for ${name}: expected ${expected}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") fail(name, "string");
  return value;
}

export function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    fail(name, "string[]");
  }
  return value;
}

export function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(name, "positive integer");
  }
  return value;
}

export function validateSpawnRequest(value: unknown): SpawnRequest {
  if (!isRecord(value)) fail("pty:spawn", "SpawnRequest object");
  return {
    ptyId: requireString(value.ptyId, "pty:spawn.ptyId"),
    command: requireString(value.command, "pty:spawn.command"),
    cwd: requireString(value.cwd, "pty:spawn.cwd"),
    cols: requirePositiveInt(value.cols, "pty:spawn.cols"),
    rows: requirePositiveInt(value.rows, "pty:spawn.rows"),
  };
}

function validateWorkingTab(value: unknown, name: string): WorkingTab {
  if (!isRecord(value)) fail(name, "WorkingTab object");
  return {
    id: requireString(value.id, `${name}.id`),
    presetId: requireString(value.presetId, `${name}.presetId`),
    name: requireString(value.name, `${name}.name`),
  };
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  if (!isRecord(value)) fail("projects:update", "ProjectConfig object");
  if (!Array.isArray(value.tabs)) fail("projects:update.tabs", "WorkingTab[]");
  return {
    slug: requireString(value.slug, "projects:update.slug"),
    name: requireString(value.name, "projects:update.name"),
    directory: requireString(value.directory, "projects:update.directory"),
    tabs: value.tabs.map((tab, idx) =>
      validateWorkingTab(tab, `projects:update.tabs[${idx}]`),
    ),
  };
}

export function validatePresetArray(value: unknown): Preset[] {
  if (!Array.isArray(value)) fail("presets:save", "Preset[]");
  value.forEach((preset, idx) => {
    if (!isPreset(preset)) fail(`presets:save[${idx}]`, "Preset");
  });
  return value;
}

function optionalString(
  value: unknown,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function validateThemeColors(value: unknown, name: string): ThemeColors {
  if (!isRecord(value)) fail(name, "ThemeColors object");
  return {
    background: requireString(value.background, `${name}.background`),
    foreground: requireString(value.foreground, `${name}.foreground`),
    cursor: requireString(value.cursor, `${name}.cursor`),
    ...(optionalString(value.cursorAccent, `${name}.cursorAccent`)
      ? { cursorAccent: value.cursorAccent as string }
      : {}),
    ...(optionalString(
      value.selectionBackground,
      `${name}.selectionBackground`,
    )
      ? { selectionBackground: value.selectionBackground as string }
      : {}),
    black: requireString(value.black, `${name}.black`),
    red: requireString(value.red, `${name}.red`),
    green: requireString(value.green, `${name}.green`),
    yellow: requireString(value.yellow, `${name}.yellow`),
    blue: requireString(value.blue, `${name}.blue`),
    magenta: requireString(value.magenta, `${name}.magenta`),
    cyan: requireString(value.cyan, `${name}.cyan`),
    white: requireString(value.white, `${name}.white`),
    brightBlack: requireString(value.brightBlack, `${name}.brightBlack`),
    brightRed: requireString(value.brightRed, `${name}.brightRed`),
    brightGreen: requireString(value.brightGreen, `${name}.brightGreen`),
    brightYellow: requireString(value.brightYellow, `${name}.brightYellow`),
    brightBlue: requireString(value.brightBlue, `${name}.brightBlue`),
    brightMagenta: requireString(value.brightMagenta, `${name}.brightMagenta`),
    brightCyan: requireString(value.brightCyan, `${name}.brightCyan`),
    brightWhite: requireString(value.brightWhite, `${name}.brightWhite`),
  };
}

function validateTheme(value: unknown, name: string): Theme {
  if (!isRecord(value)) fail(name, "Theme object");
  return {
    id: requireString(value.id, `${name}.id`),
    name: requireString(value.name, `${name}.name`),
    colors: validateThemeColors(value.colors, `${name}.colors`),
  };
}

export function validateThemesFile(value: unknown): ThemesFile {
  if (!isRecord(value)) fail("themes:save", "ThemesFile object");
  if (!Array.isArray(value.themes)) fail("themes:save.themes", "Theme[]");
  return {
    themes: value.themes.map((theme, idx) =>
      validateTheme(theme, `themes:save.themes[${idx}]`),
    ),
    activeId: requireString(value.activeId, "themes:save.activeId"),
  };
}
