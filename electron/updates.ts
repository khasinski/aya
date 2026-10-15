// App-wide update status, updater events and install handoff. Windows, native UI and the app stay with main.ts.

import type { App, BrowserWindow, Dialog, NotificationConstructorOptions, Shell } from "electron";
import type { autoUpdater } from "electron-updater";
import type { PtyLogWriter } from "./pty-log";
import { backgroundWorkKnown, confirmRestart, confirmRestartOnce, type RelaunchDeps } from "./relaunch-notes";
import type { UpdateStatus } from "./types";
import {
  diagnoseRelaunch,
  readPendingUpdate,
  markPendingUpdate,
  markPendingUpdateSync,
  clearPendingUpdate,
  cleanShipItCache,
  shouldCleanShipItCache,
} from "./update-recovery";

export const UPDATE_AUTO_CHECK_DELAY_MS = 12_000;
// The install an ordinary quit started holds the quit this long at most before it quits without it.
const QUIT_INSTALL_SETTLE_MS = 15_000;

export function updateVersion(info: unknown): string | undefined {
  return typeof info === "object" &&
    info !== null &&
    typeof (info as { version?: unknown }).version === "string"
    ? (info as { version: string }).version
    : undefined;
}

export interface UpdatesDeps {
  app: Pick<App, "isPackaged" | "getVersion" | "quit">;
  /** electron-updater builds its platform updater on first touch. */
  autoUpdater: () => typeof autoUpdater;
  isDev: boolean;
  platform: NodeJS.Platform;
  env: { APPIMAGE?: string };
  eachAyaWindow: (fn: (win: BrowserWindow) => void) => void;
  diagnosticsLog: PtyLogWriter;
  dialog: Pick<Dialog, "showMessageBox">;
  shell: Pick<Shell, "openExternal">;
  notifications: {
    isSupported: () => boolean;
    create: (options: NotificationConstructorOptions) => { show(): void };
  };
  relaunchDeps: RelaunchDeps;
  askRestart: (yes: string, text: string) => Promise<boolean>;
}

export function createUpdates(deps: UpdatesDeps) {
  const { app, eachAyaWindow, diagnosticsLog, dialog, shell, relaunchDeps, askRestart } = deps;

  let updateStatus: UpdateStatus = {
    phase: "idle",
    supported: false,
    currentVersion: "0.0.0",
  };
  let updateEventsConfigured = false;
  let updateCheckInFlight: Promise<UpdateStatus> | null = null;
  // True from the moment we hand off to ShipIt until we quit (#78). A second
  // install click must not spawn a second ShipIt - overlapping install requests
  // are a suspected cause of the silent-rollback failure.
  const updateLatch = { installing: false };
  // Sticky #78 warning: the phase it used to live in is replaced by the startup
  // auto-check 12 s later, so it is merged in separately and cleared on apply.
  let rollbackNotice: string | null = null;
  // Where to send a user whose auto-update silently failed (#78).
  const RELEASES_URL = "https://github.com/khasinski/aya/releases/latest";

  function updatesSupportedMessage(): string {
    if (deps.isDev || !app.isPackaged) return "Updates are disabled in development builds.";
    if (deps.platform === "darwin") return "";
    if (deps.platform === "linux") {
      return deps.env.APPIMAGE
        ? ""
        : "Automatic install is only available for the AppImage build on Linux.";
    }
    return "Automatic updates are not supported on this platform.";
  }

  function updateStatusBase(): Pick<
    UpdateStatus,
    "supported" | "currentVersion" | "rollbackNotice"
  > {
    return {
      supported: updatesSupportedMessage() === "",
      currentVersion: app.getVersion(),
      // Merged into every status write so it survives the 12 s auto-check.
      ...(rollbackNotice ? { rollbackNotice } : {}),
    };
  }

  function setUpdateStatus(
    next: Omit<UpdateStatus, "supported" | "currentVersion">,
    // Kept for call-site compat; updates are app-wide, so the status is
    // broadcast to every live window regardless of which one was passed.
    _win: BrowserWindow | null = null,
  ): UpdateStatus {
    updateStatus = {
      ...updateStatusBase(),
      ...next,
    };
    eachAyaWindow((win) => {
      win.webContents.send("updates:status", updateStatus);
    });
    return updateStatus;
  }

  function getUpdateStatus(): UpdateStatus {
    if (updatesSupportedMessage()) {
      return {
        ...updateStatusBase(),
        phase: "unsupported",
        message: updatesSupportedMessage(),
      };
    }
    return {
      ...updateStatus,
      ...updateStatusBase(),
    };
  }

  /** A requested update against the version we came back as (#78): a silent ShipIt rollback looks like success,
   *  so its state is cleaned, the update marked errored, and the user pointed at the releases page. */
  async function reconcilePendingUpdate(win: BrowserWindow | null): Promise<void> {
    const pending = await readPendingUpdate();
    const diagnosis = diagnoseRelaunch(pending, app.getVersion());
    if (diagnosis === "none") return;
    await clearPendingUpdate();
    updateLatch.installing = false;
    if (diagnosis === "applied") {
      rollbackNotice = null; // an install landed; retire any earlier warning
      return; // it worked; stay quiet
    }
    // Rolled back: the install silently failed and we relaunched the old bundle.
    diagnosticsLog.append("update-rolled-back", {
      target: pending?.targetVersion,
      current: app.getVersion(),
      attempts: pending?.attempts,
    });
    // The notice is cheap and true either way; the recursive wipe can land under
    // a live install, so it waits for a repeat failure.
    if (shouldCleanShipItCache(pending)) await cleanShipItCache();
    rollbackNotice = `The update to ${pending?.targetVersion} didn't install - still on ${app.getVersion()}. Try the DMG from the releases page.`;
    setUpdateStatus({
      phase: "error",
      message: rollbackNotice,
    });
    const message = `Update to ${pending?.targetVersion} didn't apply`;
    const detail = `Aya is still on ${app.getVersion()}. The in-app update failed to install and rolled back to the current version. You can install the latest release manually.`;
    const opts: Electron.MessageBoxOptions = {
      type: "warning",
      buttons: ["Open releases page", "Later"],
      defaultId: 0,
      cancelId: 1,
      message,
      detail,
    };
    const choice =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
    if (choice.response === 0) await shell.openExternal(RELEASES_URL);
  }

  function configureAutoUpdates(win: BrowserWindow): void {
    if (updateEventsConfigured) return;
    updateEventsConfigured = true;
    updateStatus = getUpdateStatus();
    if (!updateStatus.supported) return;

    deps.autoUpdater().autoDownload = true;
    // Never on a quit by itself: an ordinary quit checks the panes' background work first (before-quit).
    deps.autoUpdater().autoInstallOnAppQuit = false;
    deps.autoUpdater().allowPrerelease = false;

    deps.autoUpdater().on("checking-for-update", () => {
      setUpdateStatus({ phase: "checking", message: "Checking for updates." }, win);
    });
    deps.autoUpdater().on("update-available", (info) => {
      setUpdateStatus(
        {
          phase: "available",
          availableVersion: updateVersion(info),
          message: "Update found. Downloading in the background.",
          checkedAt: new Date().toISOString(),
        },
        win,
      );
    });
    deps.autoUpdater().on("update-not-available", (info) => {
      setUpdateStatus(
        {
          phase: "not-available",
          availableVersion: updateVersion(info),
          message: "Aya is up to date.",
          checkedAt: new Date().toISOString(),
        },
        win,
      );
    });
    deps.autoUpdater().on("download-progress", (progress) => {
      setUpdateStatus(
        {
          phase: "downloading",
          percent:
            typeof progress.percent === "number"
              ? Math.max(0, Math.min(100, progress.percent))
              : undefined,
          message: "Downloading update.",
        },
        win,
      );
    });
    deps.autoUpdater().on("update-downloaded", (info) => {
      const downloadedVersion = updateVersion(info);
      setUpdateStatus(
        {
          phase: "downloaded",
          downloadedVersion,
          message: downloadedVersion
            ? `Aya ${downloadedVersion} is ready to install.`
            : "Update is ready to install.",
        },
        win,
      );
      if (deps.notifications.isSupported()) {
        deps.notifications.create({
          title: "Aya update ready",
          body: "Restart Aya to install the update.",
        }).show();
      }
    });
    deps.autoUpdater().on("error", (error) => {
      // quitAndInstall reports a failed handoff HERE rather than throwing, so this
      // is the only place an async install failure can release the latch. The
      // marker is deliberately kept: `error` also fires for unrelated checks, and
      // deleting it there would cost the whole #78 detector.
      updateLatch.installing = false;
      setUpdateStatus({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      });
    });
  }

  async function checkForUpdates(): Promise<UpdateStatus> {
    if (updatesSupportedMessage()) return getUpdateStatus();
    if (updateCheckInFlight) return updateCheckInFlight;
    updateCheckInFlight = (async () => {
      try {
        setUpdateStatus({ phase: "checking", message: "Checking for updates." });
        await deps.autoUpdater().checkForUpdates();
        return getUpdateStatus();
      } catch (err) {
        return setUpdateStatus({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        });
      } finally {
        updateCheckInFlight = null;
      }
    })();
    return updateCheckInFlight;
  }

  /** Restart to update (asks before stopping work in panes) and an ordinary quit's update (installs only past no
   *  background work, else leaves it for Restart to update). Markers are written for diagnoseRelaunch (#78). */
  const updates = updateInstaller({
    status: getUpdateStatus,
    relaunch: relaunchDeps,
    ask: (text) => askRestart("Restart to update", text),
    latch: updateLatch,
    mark: markPendingUpdate,
    markSync: markPendingUpdateSync,
    clearMark: clearPendingUpdate,
    // Lazy: electron-updater builds its platform updater on first touch, which must not happen at module load.
    updater: {
      get autoRunAppAfterInstall() { return deps.autoUpdater().autoRunAppAfterInstall; },
      set autoRunAppAfterInstall(value: boolean) { deps.autoUpdater().autoRunAppAfterInstall = value; },
      quitAndInstall: (isSilent, isForceRunAfter) => deps.autoUpdater().quitAndInstall(isSilent, isForceRunAfter),
    },
    quit: () => app.quit(),
    failed: (message) => setUpdateStatus({ phase: "error", message }),
    settleMs: QUIT_INSTALL_SETTLE_MS,
  });

  return {
    getUpdateStatus,
    configureAutoUpdates,
    reconcilePendingUpdate,
    checkForUpdates,
    install: updates.install,
    beforeQuit: updates.beforeQuit,
  };
}

// A downloaded update replaces the PTY host: the next launch restarts it, which stops what panes run in the background
// (finding 16). Only a confirmed update or a quit with no such work installs it.

/** An ordinary quit's choice, read off the panes now; a running pane that cannot be read counts as work. */
export async function ordinaryQuitInstalls(deps: RelaunchDeps, downloaded: boolean): Promise<boolean> {
  if (!downloaded) return false;
  const work = await backgroundWorkKnown(deps).catch(() => null);
  return work !== null && work.length === 0;
}

export interface UpdateInstallDeps {
  status: () => { phase: string; downloadedVersion?: string | null };
  relaunch: RelaunchDeps;
  /** The native question before Restart to update stops work in panes. */
  ask: (text: string) => Promise<boolean>;
  /** Set from the handoff until the quit (#78); the updater's error event releases it. */
  latch: { installing: boolean };
  mark: (version: string) => Promise<void>;
  markSync: (version: string) => void;
  clearMark: () => Promise<void>;
  updater: { autoRunAppAfterInstall: boolean; quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void };
  quit: () => void;
  failed: (message: string) => void;
  /** The install an ordinary quit started holds the quit this long at most before it quits without it. */
  settleMs: number;
}

/** Restart to update (install) and an ordinary quit's update (beforeQuit), as main.ts wires them. */
export function updateInstaller(deps: UpdateInstallDeps) {
  let quitDecided = false;

  async function install(): Promise<void> {
    const status = deps.status();
    if (status.phase !== "downloaded") throw new Error("No downloaded update is ready to install.");
    // One ShipIt at a time (#78): overlapping installs are a suspected cause of the silent rollback.
    if (deps.latch.installing) return;
    if (!(await confirmRestart(deps.relaunch, "Restarting to update", deps.ask))) return;
    if (deps.latch.installing) return;
    deps.latch.installing = true;
    try {
      // Before the handoff, since quitAndInstall quits; inside the try so a failed write releases the latch.
      if (status.downloadedVersion) await deps.mark(status.downloadedVersion);
      deps.updater.quitAndInstall(false, true);
    } catch (err) {
      // A synchronous handoff failure is observable; the async ShipIt one is caught on the next launch.
      deps.latch.installing = false;
      await deps.clearMark();
      deps.failed(`Couldn't start the update: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function installOnQuit(): Promise<void> {
    const status = deps.status();
    if (!(await ordinaryQuitInstalls(deps.relaunch, status.phase === "downloaded"))) return deps.quit();
    deps.latch.installing = true;
    try {
      if (status.downloadedVersion) deps.markSync(status.downloadedVersion);
      deps.updater.autoRunAppAfterInstall = false;
      deps.updater.quitAndInstall(false, false);
    } catch {
      deps.latch.installing = false;
      await deps.clearMark();
      return deps.quit();
    }
    // The updater quits once the installer has it; a handoff that fails asynchronously must not keep Aya open.
    setTimeout(() => deps.quit(), deps.settleMs).unref();
  }

  /** before-quit: holds the first quit with a downloaded update while it decides; null lets the quit go on. */
  function beforeQuit(event: { preventDefault: () => void }): Promise<void> | null {
    if (quitDecided || deps.latch.installing || deps.status().phase !== "downloaded") return null;
    quitDecided = true;
    event.preventDefault();
    return installOnQuit().catch(() => deps.quit());
  }

  return { install, beforeQuit };
}

/** On launch with a stale host: restarts it unless that stops work in a pane the user did not agree to stop and
 *  keeps now; true when restarted. An old host whose panes cannot be read is restarted, as before the question. */
export async function restartStaleHost(deps: RelaunchDeps, ask: (text: string) => Promise<boolean>, restart: () => Promise<unknown>): Promise<boolean> {
  if (!(await confirmRestartOnce(deps, "Restarting the terminals for Aya's updated terminal host", ask).catch(() => true))) return false;
  await restart();
  return true;
}
