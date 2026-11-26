// A terminal pane's `aya present` artifacts (tui-artifacts.ts) for its header: list them, open one in its window, and
// tell the windows when one arrives or changes so the header's count and its unseen mark follow.

import type { IpcMain } from "electron";
import { summarizeArtifact, type TuiArtifactStore } from "../tui-artifacts";
import type { GuiArtifact } from "../../shared/codex-gui";
import type { TuiArtifactsChange } from "../../shared/ipc-types";
import { requireString } from "../validation";

export interface TuiArtifactsIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  store: TuiArtifactStore;
  show: (artifact: GuiArtifact) => void;
  /** Sends the change to every Aya window. */
  broadcast: (change: TuiArtifactsChange) => void;
}

export function registerTuiArtifactsIpc({ ipcMain, store, show, broadcast }: TuiArtifactsIpcDeps): void {
  store.onChange((terminalId, item, { updated, opened, removed }) => {
    if (terminalId || removed.length) broadcast({ terminalId: terminalId ?? "", artifact: summarizeArtifact(item), updated, opened, ...(removed.length ? { removed } : {}) });
  });
  ipcMain.handle("tui-artifacts:list", async (_e, rawPtyId: unknown) => {
    const ptyId = requireString(rawPtyId, "tui-artifacts:list.ptyId");
    await store.load();
    return store.list(ptyId).map(summarizeArtifact);
  });
  ipcMain.handle("tui-artifacts:open", async (_e, rawPtyId: unknown, rawId: unknown) => {
    const ptyId = requireString(rawPtyId, "tui-artifacts:open.ptyId");
    const id = requireString(rawId, "tui-artifacts:open.id");
    await store.load();
    const item = store.get(id);
    if (!item || item.terminalId !== ptyId) throw new Error(`This pane has no artifact "${id}"`);
    show(item.artifact);
  });
}
