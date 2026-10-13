// Project IPC: the project list, each window's slice of the open projects (read and save), creating and updating
// projects, and a cloned repo's own .aya/project.json.

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  createProject,
  createRemoteProject,
  listProjects,
  listProjectState,
  saveProjectState,
  updateProject,
} from "../config";
import { PROJECTS_STATE_DELAY_MS } from "../paths";
import { readRepoProjectConfig } from "../project-local";
import type { ProjectCollectionState } from "../types";
import { requireString, validateProjectCollectionState, validateProjectConfig } from "../validation";

export interface ProjectsIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  senderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null;
  /** A window's slice of the on-disk state (multi-window). */
  stateForWindow: (state: ProjectCollectionState, windowId: number) => ProjectCollectionState;
  /** A window's saved slice merged into the state on disk (null when it could not be read). */
  mergeSave: (state: ProjectCollectionState, windowId: number, disk: ProjectCollectionState | null) => ProjectCollectionState;
}

export function registerProjectsIpc(deps: ProjectsIpcDeps): void {
  const { ipcMain, senderWindow } = deps;
  ipcMain.handle("projects:list", async () => listProjects());
  ipcMain.handle("projects:state", async (e) => {
    if (PROJECTS_STATE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, PROJECTS_STATE_DELAY_MS));
    const state = await listProjectState();
    const win = senderWindow(e);
    // Each window sees only its own open-project slice (multi-window). No
    // window (e.g. remote server path) gets the full on-disk state.
    return win ? deps.stateForWindow(state, win.id) : state;
  });
  ipcMain.handle("projects:save-state", async (e, state: unknown) => {
    const valid = validateProjectCollectionState(state);
    const win = senderWindow(e);
    if (!win) return saveProjectState(valid);
    const disk = await listProjectState().catch(() => null);
    return saveProjectState(deps.mergeSave(valid, win.id, disk));
  });
  ipcMain.handle("projects:create", async (_e, name: unknown, dir: unknown) =>
    createProject(
      requireString(name, "projects:create.name"),
      requireString(dir, "projects:create.dir"),
    ),
  );
  ipcMain.handle("projects:create-remote", async (_e, req: unknown) => {
    if (typeof req !== "object" || req === null || Array.isArray(req)) {
      throw new Error("projects:create-remote.req must be an object");
    }
    const r = req as Record<string, unknown>;
    return createRemoteProject({
      name: requireString(r.name, "projects:create-remote.name"),
      directory: requireString(r.directory, "projects:create-remote.directory"),
      hostId: requireString(r.hostId, "projects:create-remote.hostId"),
      label: requireString(r.label, "projects:create-remote.label"),
      sshTarget: requireString(r.sshTarget, "projects:create-remote.sshTarget"),
    });
  });
  ipcMain.handle("projects:update", async (_e, project: unknown) =>
    updateProject(validateProjectConfig(project)),
  );
  ipcMain.handle("projects:read-repo-config", async (_e, dir: unknown) =>
    readRepoProjectConfig(requireString(dir, "projects:read-repo-config.dir")),
  );
}
