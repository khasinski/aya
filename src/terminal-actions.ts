import { PRESET_ID_BOARD, PRESET_ID_SHELL } from "./preset-ids";
import { BUILTIN_SHELL, type Preset, type ProjectConfig, type TerminalState } from "./types";

export function projectLaunchCwd(
  project: ProjectConfig,
  projectFallbacks: Record<string, string>,
): string {
  return projectFallbacks[project.slug] ?? project.directory;
}

export function shellPresetForTab(sourcePresets: Preset[]): Preset {
  return sourcePresets.find((p) => p.id === PRESET_ID_SHELL) ?? sourcePresets[0] ?? BUILTIN_SHELL;
}

export function nextActiveTerminalId(
  nextTerminals: Record<string, TerminalState>,
  projectSlug: string,
): string | null {
  const remaining = Object.values(nextTerminals).filter(
    (x) => x.projectSlug === projectSlug,
  );
  const nonBoard = remaining.filter((x) => x.presetId !== PRESET_ID_BOARD);
  if (nonBoard.length > 0) return nonBoard[nonBoard.length - 1].id;
  return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
}
