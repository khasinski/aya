// Remote IPC: directories, presets, health and projects on another computer over ssh, and the machines the status
// bar and Settings > Machines manage (the same functions `aya machines` runs).

import * as os from "node:os";
import type { IpcMain } from "electron";
import { listProjects } from "../config";
import { handleMachinesRequest, machinesDiscover, machinesSetup, machinesStatus, machinesUiSetup } from "../machines";
import { ayaMachinesDeps } from "../machines-dialog";
import {
  checkRemoteHealth,
  createRemoteDirectory,
  createRemoteProjectOnHost,
  listRemoteDirectory,
  listRemotePresets,
} from "../remote-client";
import { requireString } from "../validation";

export interface RemoteIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  ayaHome: string;
}

export function registerRemoteIpc(deps: RemoteIpcDeps): void {
  const { ipcMain } = deps;
  ipcMain.handle(
    "remote:list-directory",
    async (_e, sshTarget: unknown, directory: unknown) =>
      listRemoteDirectory(
        requireString(sshTarget, "remote:list-directory.sshTarget"),
        typeof directory === "string" ? directory : undefined,
      ),
  );
  ipcMain.handle(
    "remote:create-directory",
    async (_e, sshTarget: unknown, directory: unknown) =>
      createRemoteDirectory(
        requireString(sshTarget, "remote:create-directory.sshTarget"),
        requireString(directory, "remote:create-directory.directory"),
      ),
  );
  ipcMain.handle("remote:list-presets", async (_e, sshTarget: unknown) =>
    listRemotePresets(requireString(sshTarget, "remote:list-presets.sshTarget")),
  );
  ipcMain.handle("remote:health", async (_e, sshTarget: unknown) =>
    checkRemoteHealth(requireString(sshTarget, "remote:health.sshTarget")),
  );
  ipcMain.handle(
    "remote:create-project",
    async (_e, sshTarget: unknown, directory: unknown, name: unknown) =>
      createRemoteProjectOnHost(
        requireString(sshTarget, "remote:create-project.sshTarget"),
        requireString(directory, "remote:create-project.directory"),
        typeof name === "string" ? name : undefined,
      ),
  );

  // A click in Aya is the user's own yes, so these adds, removes and backend changes ask no dialog; an agent's
  // `aya machines add`, `remove` and `configure` do.
  const machinesDeps = {
    ...ayaMachinesDeps(deps.ayaHome, os.homedir(), () => null, () => listProjects()),
    confirmAdd: async () => true,
    confirmRemove: async () => true,
    confirmConfigure: async () => true,
  };
  ipcMain.handle("machines:status", () => machinesStatus(machinesDeps));
  ipcMain.handle("machines:setup", (e) => e.sender ? machinesUiSetup(machinesDeps) : machinesSetup(machinesDeps));
  ipcMain.handle("machines:discover", (_e, id: unknown) => machinesDiscover(requireString(id, "machines:discover.id"), machinesDeps));
  ipcMain.handle("machines:configure", async (_e, argv: unknown, token: unknown) => {
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string") || argv[0] !== "configure" || (token !== undefined && typeof token !== "string")) {
      throw new Error("machines:configure needs configuration arguments and optional token input");
    }
    return (await handleMachinesRequest({ argv, ...(typeof token === "string" ? { token } : {}) }, machinesDeps)).output;
  });
  ipcMain.handle("machines:command", async (_e, argv: unknown) => {
    if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string") || !["add", "remove", "claim", "release"].includes(argv[0])) {
      throw new Error("machines:command takes add, remove, claim or release with text arguments");
    }
    return (await handleMachinesRequest({ argv, user: os.userInfo().username }, machinesDeps)).output;
  });
}
