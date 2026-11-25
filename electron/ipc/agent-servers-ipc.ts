// Local servers a terminal pane's process started (agent-servers.ts): list them, or stop one. Opening one goes
// through the window's ordinary external-URL path (env:open-url). Conversation GUI panes use the codex-gui channel.

import type { IpcMain } from "electron";
import { listAgentServers, stopAgentServer, type AgentServerDeps } from "../agent-servers";
import { requireString } from "../validation";

export interface AgentServersIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** The pane's process, null or undefined when it has none or the host cannot say. */
  getPid: (ptyId: string) => Promise<number | null | undefined>;
  /** A remote pane's pid belongs to another machine. */
  isRemote?: (ptyId: string) => boolean;
  system?: AgentServerDeps;
}

export function registerAgentServersIpc({ ipcMain, getPid, isRemote = () => false, system }: AgentServersIpcDeps): void {
  ipcMain.handle("pty:servers", async (_e, rawPtyId: unknown, action: unknown, pid: unknown) => {
    const ptyId = requireString(rawPtyId, "pty:servers.ptyId");
    if (isRemote(ptyId)) {
      if (action === "stop") throw new Error("Servers on a remote machine cannot be stopped from here");
      return [];
    }
    const root = await getPid(ptyId);
    if (action === "stop") return stopAgentServer(root, Number(pid), system);
    return listAgentServers(root, system);
  });
}
