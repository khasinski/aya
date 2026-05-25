// Types shared between the Electron main and the renderer via the preload
// context bridge. Keep this file pure type definitions so it can be imported
// from both sides without runtime side-effects.

import type { Preset } from "./presets";
import type { Theme, ThemesFile } from "./themes";

export type { Preset, Theme, ThemesFile };

export interface WorkingTab {
  id: string;
  presetId: string;
  name: string;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  directory: string;
  tabs: WorkingTab[];
}

export interface SpawnRequest {
  ptyId: string;
  // The user-resolved command (e.g. "claude", "$SHELL", "aider --dark"). The
  // renderer picks this from the active preset and the main process embeds it
  // verbatim into `bash -lc 'cd … && exec <command>'`. NEVER -p / --print.
  command: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface ProjectGitInfo {
  branch: string | null;
  dirty: number;
}

export type PtyEvent =
  | { type: "data"; ptyId: string; chunk: string }
  | { type: "exit"; ptyId: string; exitCode: number };

// What the preload exposes to window.aya:
export interface AyaApi {
  /** True when running under `npm run dev` (AYA_DEV=1). False in the packaged
   *  Aya.app. Use to show a "dev" indicator and keep the user's dogfooded
   *  state in ~/.aya/ from being touched. */
  isDev: boolean;

  // PTY lifecycle
  ptySpawn(req: SpawnRequest): Promise<void>;
  ptyWrite(ptyId: string, data: string): Promise<void>;
  ptyResize(ptyId: string, cols: number, rows: number): Promise<void>;
  ptyKill(ptyId: string): Promise<void>;
  onPtyEvent(handler: (event: PtyEvent) => void): () => void;

  // Project config
  listProjects(): Promise<ProjectConfig[]>;
  createProject(name: string, directory: string): Promise<ProjectConfig>;
  updateProject(project: ProjectConfig): Promise<void>;
  deleteProject(slug: string): Promise<void>;

  // Presets (terminal launchers)
  listPresets(): Promise<Preset[]>;
  savePresets(presets: Preset[]): Promise<void>;

  // Themes (terminal color schemes — xterm.js ITheme shape internally)
  listThemes(): Promise<ThemesFile>;
  saveThemes(file: ThemesFile): Promise<void>;
  /** Opens a file picker for .itermcolors / .json, parses, returns the
   *  imported Theme — caller adds it to the list and persists. */
  importTheme(): Promise<Theme | null>;

  // Environment + git
  getCwd(): Promise<string>;
  getHomeDir(): Promise<string>;
  expandPath(path: string): Promise<string>;
  getGitInfo(directory: string): Promise<ProjectGitInfo>;
  pickDirectory(): Promise<string | null>;
  /** True if the path exists and is a directory. */
  dirExists(path: string): Promise<boolean>;
  /** `mkdir -p` semantics. Throws if the path can't be created. */
  createDir(path: string): Promise<void>;

  // Window state
  isFullScreen(): Promise<boolean>;
  onFullScreenChange(handler: (isFullScreen: boolean) => void): () => void;
}

declare global {
  interface Window {
    aya: AyaApi;
  }
}
