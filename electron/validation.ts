import type {
  ProjectCollectionState,
  ProjectConfig,
  SplitLayout,
  SpawnRequest,
  Theme,
  ThemesFile,
  WorkingTab,
} from "./types";
import type { Preset } from "./presets";
import type { Snippet } from "./snippets";
import type { ThemeColors } from "./themes";
import { isPreset } from "./presets";
import { isSnippet, SNIPPET_TEXT_MAX } from "./snippets";

/** Hard IPC ceiling on the number of snippets accepted in one save. Well above
 *  the 200 persistence cap so normal saves pass; rejects only clearly hostile
 *  payloads before any per-item work happens. */
const SNIPPETS_IPC_MAX = 1_000;

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
    ...(optionalString(value.projectSlug, "pty:spawn.projectSlug")
      ? { projectSlug: value.projectSlug as string }
      : {}),
    ...(optionalString(value.presetId, "pty:spawn.presetId")
      ? { presetId: value.presetId as string }
      : {}),
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

function optionalNumberArray(value: unknown, name: string): number[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
  ) {
    fail(name, "positive number[]");
  }
  return value;
}

function validateSplitLayout(value: unknown): SplitLayout {
  if (!isRecord(value)) fail("projects:update.splitLayout", "SplitLayout object");
  const rows = requirePositiveInt(value.rows, "projects:update.splitLayout.rows");
  const cols = requirePositiveInt(value.cols, "projects:update.splitLayout.cols");
  if (rows > 5) fail("projects:update.splitLayout.rows", "integer <= 5");
  if (cols > 5) fail("projects:update.splitLayout.cols", "integer <= 5");
  const size = rows * cols;
  const cellsValue = value.cells;
  if (
    !Array.isArray(cellsValue) ||
    !cellsValue.every((cell) => cell === null || typeof cell === "string")
  ) {
    fail("projects:update.splitLayout.cells", "(string|null)[]");
  }
  const cells = cellsValue.slice(0, size);
  while (cells.length < size) cells.push(null);
  const rowFr = optionalNumberArray(value.rowFr, "projects:update.splitLayout.rowFr").slice(0, rows);
  const colFr = optionalNumberArray(value.colFr, "projects:update.splitLayout.colFr").slice(0, cols);
  while (rowFr.length < rows) rowFr.push(1);
  while (colFr.length < cols) colFr.push(1);
  const activeCell =
    typeof value.activeCell === "number" && Number.isInteger(value.activeCell)
      ? Math.max(0, Math.min(size - 1, value.activeCell))
      : 0;
  return { rows, cols, rowFr, colFr, cells, activeCell };
}

export function validateProjectConfig(value: unknown): ProjectConfig {
  if (!isRecord(value)) fail("projects:update", "ProjectConfig object");
  if (!Array.isArray(value.tabs)) fail("projects:update.tabs", "WorkingTab[]");
  const tabs = value.tabs.map((tab, idx) =>
    validateWorkingTab(tab, `projects:update.tabs[${idx}]`),
  );
  return {
    slug: requireString(value.slug, "projects:update.slug"),
    name: requireString(value.name, "projects:update.name"),
    directory: requireString(value.directory, "projects:update.directory"),
    tabs,
    ...(value.splitLayout !== undefined
      ? { splitLayout: validateSplitLayout(value.splitLayout) }
      : {}),
  };
}

export function validateProjectCollectionState(
  value: unknown,
): ProjectCollectionState {
  if (!isRecord(value)) {
    fail("projects:save-state", "ProjectCollectionState object");
  }
  return {
    version: 1,
    order: requireStringArray(value.order, "projects:save-state.order"),
    open: requireStringArray(value.open, "projects:save-state.open"),
    recent: requireStringArray(value.recent, "projects:save-state.recent"),
  };
}

export function validatePresetArray(value: unknown): Preset[] {
  if (!Array.isArray(value)) fail("presets:save", "Preset[]");
  value.forEach((preset, idx) => {
    if (!isPreset(preset)) fail(`presets:save[${idx}]`, "Preset");
  });
  return value;
}

export function validateSnippetArray(value: unknown): Snippet[] {
  if (!Array.isArray(value)) fail("snippets:save", "Snippet[]");
  if (value.length > SNIPPETS_IPC_MAX) {
    fail("snippets:save", `at most ${SNIPPETS_IPC_MAX} snippets`);
  }
  value.forEach((snippet, idx) => {
    if (!isSnippet(snippet)) fail(`snippets:save[${idx}]`, "Snippet");
    if ((snippet as Snippet).text.length > SNIPPET_TEXT_MAX) {
      fail(`snippets:save[${idx}].text`, `text <= ${SNIPPET_TEXT_MAX} chars`);
    }
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
