// System IPC: the "waiting" notification, the Dock badge, macOS settings panes, the microphone permission, the
// aya CLI shim, the diagnostics report and updates.

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, NotificationConstructorOptions, Shell, SystemPreferences } from "electron";
import { waitingNotification } from "../native-ui-text";
import { requireString } from "../validation";

/** What the IPC needs of a desktop notification. */
export interface WaitingNotification {
  on(event: "click", listener: () => void): unknown;
  show(): void;
}

export interface SystemIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  senderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null;
  platform: NodeJS.Platform;
  notifications: {
    isSupported: () => boolean;
    create: (options: NotificationConstructorOptions) => WaitingNotification;
  };
  shell: Pick<Shell, "openExternal">;
  systemPreferences: Pick<SystemPreferences, "getMediaAccessStatus" | "askForMediaAccess">;
  /** macOS Dock, absent elsewhere. */
  dock: { setBadge: (text: string) => void } | undefined;
  cliStatus: () => unknown;
  installCli: () => unknown;
  diagnosticsReport: () => unknown;
  updateStatus: () => unknown;
  checkForUpdates: () => unknown;
  installUpdate: () => unknown;
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
  const { ipcMain, platform, shell } = deps;
  ipcMain.handle("app:notify-waiting", async (e, req: unknown) => {
    if (!deps.notifications.isSupported()) return;
    // The notifying renderer owns the terminal - clicking the notification
    // must focus THAT window, which may not exist anymore by click time.
    const win = deps.senderWindow(e);
    const projectSlug = requireString(
      (req as Record<string, unknown> | null)?.projectSlug,
      "app:notify-waiting.projectSlug",
    );
    const terminalId = requireString(
      (req as Record<string, unknown> | null)?.terminalId,
      "app:notify-waiting.terminalId",
    );
    const body = requireString(
      (req as Record<string, unknown> | null)?.body,
      "app:notify-waiting.body",
    );
    const notification = deps.notifications.create(waitingNotification(body));
    notification.on("click", () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      win.webContents.send("notification:select-terminal", {
        projectSlug,
        terminalId,
      });
    });
    notification.show();
  });
  ipcMain.handle("app:cli-status", async () => deps.cliStatus());
  ipcMain.handle("app:install-cli", async () => deps.installCli());
  ipcMain.handle("app:diagnostics", async () => deps.diagnosticsReport());
  ipcMain.handle("updates:status", async () => deps.updateStatus());
  ipcMain.handle("updates:check", async () => deps.checkForUpdates());
  ipcMain.handle("updates:install", () => deps.installUpdate());
  ipcMain.handle("app:open-notification-settings", async () => {
    if (platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      );
    }
  });
  ipcMain.handle("app:open-local-network-settings", async () => {
    if (platform === "darwin") {
      // The Local Network anchor is unreliable on macOS 26. Open the parent pane; the UI names the next step.
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security");
    }
  });
  // Microphone access surfaced read-only in Settings: Aya never records, but
  // CLI tools the user runs (e.g. a /voice plugin) may. macOS owns the actual
  // grant/revoke; these just report status, trigger the system prompt, and
  // deep-link to the real toggle. See build/entitlements.mac.plist (audio-input).
  ipcMain.handle("mic:status", async () => {
    if (platform !== "darwin") return "unsupported";
    return deps.systemPreferences.getMediaAccessStatus("microphone");
  });
  ipcMain.handle("mic:request", async () => {
    if (platform !== "darwin") return true;
    // No-op (returns immediately) if already granted/denied; only prompts when
    // status is not-determined.
    return deps.systemPreferences.askForMediaAccess("microphone");
  });
  ipcMain.handle("mic:open-settings", async () => {
    if (platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
    }
  });
  // Dock badge for unattended notifications (waiting terminals). Empty
  // string clears. macOS only; no-op on Linux/Windows for now since their
  // taskbar badge stories differ.
  ipcMain.handle("app:set-dock-badge", async (_e, text: unknown) => {
    const badge = requireString(text, "app:set-dock-badge.text");
    if (platform === "darwin" && deps.dock) {
      try {
        deps.dock.setBadge(badge || "");
      } catch {
        // best effort
      }
    }
  });
}
