// The env:* IPC handlers: paths, git and GitHub facts, worktrees, file pickers, opening paths and URLs, the
// clipboard. Electron's own objects come in through the deps, so the module loads (and is tested) without Electron.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserWindow, Clipboard, Dialog, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, Shell } from "electron";
import { expandPath } from "../config";
import {
  createWorktree,
  createWorktreeBatch,
  commitGitFiles,
  getGitChangedFiles,
  getGitDiff,
  getGitInfo,
  getGitRoot,
  listWorktreeStatus,
  removeWorktree,
  removeWorktreeAndBranch,
  worktreeBranchRemovalInfo,
} from "../git";
import { getGitHubLink, isGitHubCliAvailable } from "../github";
import { optionalTrimmed, requireRecord, requireString } from "../validation";

/** At most this many directory suggestions per completion request. */
export const MAX_PATH_COMPLETION_ENTRIES = 100;

export interface EnvIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** The window that sent the request, or null (Aya Web, a closed window). */
  senderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null;
  dialog: Pick<Dialog, "showOpenDialog">;
  shell: Pick<Shell, "openPath">;
  clipboard: Pick<Clipboard, "readText" | "writeText">;
  /** The user's home, where the directory picker starts. */
  home: () => string;
  /** Opens an http(s) or file: URL; rejects anything else. */
  openExternalUrl: (url: string) => Promise<void>;
  /** Test seam; production uses the real checked git implementation. */
  commitGitFiles?: typeof commitGitFiles;
}

/** Directory names under the typed prefix, as the prefix spells them, each ending in a slash; hidden ones only
 *  once a dot is typed. */
export async function completeDirectoryPath(rawPrefix: string): Promise<string[]> {
  const raw = rawPrefix || "~/";
  const normalizedRaw = raw === "~" ? "~/" : raw;
  const endsWithSlash = normalizedRaw.endsWith("/");
  const expanded = expandPath(normalizedRaw);
  const lookupDir = endsWithSlash ? expanded : path.dirname(expanded);
  const namePrefix = endsWithSlash ? "" : path.basename(expanded);
  const rawDirPrefix = endsWithSlash
    ? normalizedRaw
    : normalizedRaw.slice(0, normalizedRaw.length - namePrefix.length);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(lookupDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      if (!namePrefix && entry.name.startsWith(".")) return false;
      return entry.name.startsWith(namePrefix);
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PATH_COMPLETION_ENTRIES)
    .map((entry) => `${rawDirPrefix}${entry.name}/`);
}

export function registerEnvIpc(deps: EnvIpcDeps): void {
  const { ipcMain, senderWindow, dialog, shell, clipboard } = deps;
  const activeGitDirectories = new WeakMap<object, string>();
  const pickPath = async (e: IpcMainInvokeEvent, options: OpenDialogOptions): Promise<string | null> => {
    const win = senderWindow(e);
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  };

  ipcMain.handle("env:cwd", async () => process.cwd());
  ipcMain.handle("env:home", async () => os.homedir());
  ipcMain.handle("env:expand", async (_e, p: unknown) =>
    expandPath(requireString(p, "env:expand.path")),
  );
  ipcMain.handle("env:complete-path", async (_e, p: unknown) =>
    completeDirectoryPath(requireString(p, "env:complete-path.path")),
  );
  ipcMain.handle("env:git", async (_e, directory: unknown) =>
    getGitInfo(requireString(directory, "env:git.directory")),
  );
  ipcMain.handle("env:set-active-git-directory", async (event, raw: unknown) => {
    const win = senderWindow(event);
    if (!win) throw new Error("This window is no longer available.");
    if (raw === null) { activeGitDirectories.delete(event.sender); return; }
    activeGitDirectories.set(event.sender, requireString(raw, "env:set-active-git-directory.directory"));
  });
  ipcMain.handle("env:git-changed-files", async (_e, directory: unknown) =>
    getGitChangedFiles(requireString(directory, "env:git-changed-files.directory")),
  );
  ipcMain.handle("env:git-commit-files", async (event, req: unknown) => {
    const r = requireRecord(req, "env:git-commit-files");
    const directory = requireString(r.directory, "env:git-commit-files.directory");
    const win = senderWindow(event);
    if (!win || activeGitDirectories.get(event.sender) !== directory) throw new Error("The checkout changed. Refresh the changed files and try again.");
    if (!Array.isArray(r.paths) || r.paths.some((item) => typeof item !== "string")) {
      throw new Error("env:git-commit-files.paths must be a list of file paths");
    }
    return (deps.commitGitFiles ?? commitGitFiles)(
      directory,
      r.paths as string[],
      requireString(r.message, "env:git-commit-files.message"),
    );
  });
  ipcMain.handle("env:git-diff", async (_e, directory: unknown) =>
    getGitDiff(requireString(directory, "env:git-diff.directory")),
  );
  ipcMain.handle("env:git-root", async (_e, directory: unknown) =>
    getGitRoot(requireString(directory, "env:git-root.directory")),
  );
  ipcMain.handle("env:git-worktree-status", async (_e, directory: unknown) =>
    listWorktreeStatus(requireString(directory, "env:git-worktree-status.directory")),
  );
  ipcMain.handle("env:github-link", async (_e, directory: unknown) =>
    getGitHubLink(requireString(directory, "env:github-link.directory")),
  );
  ipcMain.handle("env:git-worktree-add", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-add");
    return createWorktree(
      requireString(r.directory, "env:git-worktree-add.directory"),
      requireString(r.path, "env:git-worktree-add.path"),
      optionalTrimmed(r.branch),
      optionalTrimmed(r.base),
    );
  });
  ipcMain.handle("env:git-worktree-batch-add", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-batch-add");
    const count = typeof r.count === "number" && Number.isInteger(r.count) ? r.count : NaN;
    return createWorktreeBatch({
      directory: requireString(r.directory, "env:git-worktree-batch-add.directory"),
      slug: requireString(r.slug, "env:git-worktree-batch-add.slug"),
      count,
      base: requireString(r.base, "env:git-worktree-batch-add.base"),
    });
  });
  ipcMain.handle("env:git-worktree-removal-info", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-removal-info");
    return worktreeBranchRemovalInfo(
      requireString(r.directory, "env:git-worktree-removal-info.directory"),
      requireString(r.path, "env:git-worktree-removal-info.path"),
      requireString(r.base, "env:git-worktree-removal-info.base"),
    );
  });
  ipcMain.handle("env:git-worktree-remove-with-branch", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-remove-with-branch");
    return removeWorktreeAndBranch(
      requireString(r.directory, "env:git-worktree-remove-with-branch.directory"),
      requireString(r.path, "env:git-worktree-remove-with-branch.path"),
      requireString(r.base, "env:git-worktree-remove-with-branch.base"),
      r.deleteBranch === true,
      r.expectedBranch === null ? null : requireString(r.expectedBranch, "env:git-worktree-remove-with-branch.expectedBranch"),
    );
  });
  ipcMain.handle("env:git-worktree-remove", async (_e, req: unknown) => {
    const r = requireRecord(req, "env:git-worktree-remove");
    return removeWorktree(
      requireString(r.directory, "env:git-worktree-remove.directory"),
      requireString(r.path, "env:git-worktree-remove.path"),
      r.force === true,
    );
  });
  ipcMain.handle("env:github-cli-available", async () =>
    isGitHubCliAvailable(),
  );
  ipcMain.handle("env:pick-dir", async (e) =>
    pickPath(e, {
      title: "Pick a project directory",
      defaultPath: deps.home(),
      properties: ["openDirectory", "createDirectory"],
    }),
  );
  ipcMain.handle("env:pick-sound", async (e) =>
    pickPath(e, {
      title: "Pick a notification sound",
      properties: ["openFile"],
      filters: [
        { name: "Audio", extensions: ["wav", "mp3", "ogg", "m4a", "aac", "flac"] },
        { name: "All files", extensions: ["*"] },
      ],
    }),
  );
  ipcMain.handle("env:dir-exists", async (_e, p: unknown) => {
    try {
      const stat = await fs.stat(
        expandPath(requireString(p, "env:dir-exists.path")),
      );
      return stat.isDirectory();
    } catch {
      return false;
    }
  });
  ipcMain.handle("env:create-dir", async (_e, p: unknown) => {
    await fs.mkdir(expandPath(requireString(p, "env:create-dir.path")), {
      recursive: true,
    });
  });
  ipcMain.handle("env:open-path", async (_e, p: unknown) => {
    const expanded = expandPath(requireString(p, "env:open-path.path"));
    const error = await shell.openPath(expanded);
    if (error) throw new Error(error);
  });
  ipcMain.handle("env:open-url", async (_e, value: unknown) => {
    await deps.openExternalUrl(requireString(value, "env:open-url.url"));
  });
  ipcMain.handle("env:clipboard-read", async () => clipboard.readText());
  ipcMain.handle("env:clipboard-write", async (_e, value: unknown) => {
    clipboard.writeText(requireString(value, "env:clipboard-write.text"));
  });
}
