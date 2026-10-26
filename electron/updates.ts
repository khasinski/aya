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
export const SQUIRREL_HANDOFF_TIMEOUT_MS = 60_000;
const UPDATE_HANDOFF_FALLBACK = "Aya could not hand the update to macOS. Download the latest DMG from github.com/khasinski/aya/releases/latest and install it manually.";

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
  /** Native Electron updater events; distinct from electron-updater's download event. */
  onSquirrelUpdateDownloaded?: (listener: () => void) => () => void;
  onBeforeQuitForUpdate?: (listener: () => void) => () => void;
  handoffTimeoutMs?: number;
  dialog: Pick<Dialog, "showMessageBox">;
  shell: Pick<Shell, "openExternal">;
  notifications: {
    isSupported: () => boolean;
    create: (options: NotificationConstructorOptions) => { show(): void };
  };
  relaunchDeps: RelaunchDeps;
  askRestart: (yes: string, text: string) => Promise<boolean>;
  preparePlannedUpdate?:()=>Promise<boolean>;
  abortPlannedUpdate?:()=>Promise<void>;
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
  let preparingUpdate = false;
  // True from the moment we hand off to ShipIt until we quit (#78). A second
  // install click must not spawn a second ShipIt - overlapping install requests
  // are a suspected cause of the silent-rollback failure.
  const updateLatch = { installing: false };
  // Sticky #78 warning: the phase it used to live in is replaced by the startup
  // auto-check 12 s later, so it is merged in separately and cleared on apply.
  let rollbackNotice: string | null = null;
  let handleInstallHandoffError: ((error: unknown) => boolean) | null = null;
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
    "supported" | "currentVersion" | "rollbackNotice" | "preparingUpdate"
  > {
    return {
      supported: updatesSupportedMessage() === "",
      currentVersion: app.getVersion(),
      ...(preparingUpdate ? { preparingUpdate: true } : {}),
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

  function setPreparingUpdate(preparing: boolean): void {
    if (preparingUpdate === preparing) return;
    preparingUpdate = preparing;
    const { preparingUpdate: _previous, ...current } = updateStatus;
    updateStatus = { ...current, ...updateStatusBase() };
    eachAyaWindow((win) => win.webContents.send("updates:status", updateStatus));
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
      diagnosticsLog.append("update-download-done", { version: downloadedVersion });
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
      if (handleInstallHandoffError?.(error)) return;
      diagnosticsLog.append("update-error", { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
      // quitAndInstall reports a failed handoff HERE rather than throwing, so this
      // is the only place an async install failure can release the latch. The
      // marker is deliberately kept: `error` also fires for unrelated checks, and
      // deleting it there would cost the whole #78 detector.
      updateLatch.installing = false;
      void deps.abortPlannedUpdate?.().catch(()=>{});
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
    preparePlannedUpdate:deps.preparePlannedUpdate,
    abortPlannedUpdate:deps.abortPlannedUpdate,
    setPreparingUpdate,
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
    onSquirrelUpdateDownloaded: deps.onSquirrelUpdateDownloaded,
    onBeforeQuitForUpdate: deps.onBeforeQuitForUpdate,
    monitorSquirrelHandoff: deps.platform === "darwin",
    handoffTimeoutMs: deps.handoffTimeoutMs,
    log: (event, fields) => diagnosticsLog.append(event, fields),
  });
  handleInstallHandoffError = updates.onHandoffError;

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
  preparePlannedUpdate?:()=>Promise<boolean>;
  abortPlannedUpdate?:()=>Promise<void>;
  setPreparingUpdate?:(preparing:boolean)=>void;
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
  onSquirrelUpdateDownloaded?: (listener: () => void) => () => void;
  onBeforeQuitForUpdate?: (listener: () => void) => () => void;
  /** Only MacUpdater has the native Squirrel handoff that can wait indefinitely. */
  monitorSquirrelHandoff?: boolean;
  handoffTimeoutMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Restart to update (install) and an ordinary quit's update (beforeQuit), as main.ts wires them. */
export function updateInstaller(deps: UpdateInstallDeps) {
  let quitDecided = false;
  type Handoff = {
    active: boolean;
    squirrelDownloaded: boolean;
    version?: string;
    timer: ReturnType<typeof setTimeout> | null;
    offSquirrel: (() => void) | null;
    offQuit: (() => void) | null;
  };
  let handoff: Handoff | null = null;

  function stopHandoff(attempt: Handoff): void {
    if (!attempt.active) return;
    attempt.active = false;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = null;
    attempt.offSquirrel?.();
    attempt.offSquirrel = null;
    attempt.offQuit?.();
    attempt.offQuit = null;
    if (handoff === attempt) handoff = null;
  }

  async function failHandoff(attempt: Handoff, event: "update-handoff-timeout" | "update-handoff-error", error?: unknown): Promise<void> {
    if (!attempt.active) return;
    stopHandoff(attempt);
    deps.log?.(event, {
      version: attempt.version,
      ...(error === undefined ? {} : { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) }),
    });
    const errorText = error === undefined ? "" : ` Reason: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
    const timeoutSeconds = Math.ceil((deps.handoffTimeoutMs ?? SQUIRREL_HANDOFF_TIMEOUT_MS) / 1000);
    await Promise.resolve().then(() => deps.abortPlannedUpdate?.()).catch(() => {});
    await Promise.resolve().then(() => deps.clearMark()).catch(() => {});
    deps.latch.installing = false;
    deps.setPreparingUpdate?.(false);
    deps.failed(event === "update-handoff-timeout"
      ? `${UPDATE_HANDOFF_FALLBACK} The handoff did not complete within ${timeoutSeconds} second${timeoutSeconds === 1 ? "" : "s"}.`
      : `${UPDATE_HANDOFF_FALLBACK}${errorText}`);
  }

  function beginHandoff(version?: string): Handoff {
    const attempt: Handoff = {
      active: true,
      squirrelDownloaded: false,
      version,
      timer: null,
      offSquirrel: null,
      offQuit: null,
    };
    handoff = attempt;
    attempt.offSquirrel = deps.onSquirrelUpdateDownloaded?.(() => {
      if (!attempt.active || attempt.squirrelDownloaded) return;
      attempt.squirrelDownloaded = true;
      deps.log?.("update-squirrel-update-downloaded", { version: attempt.version });
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.timer = null;
      attempt.offSquirrel?.();
      attempt.offSquirrel = null;
    }) ?? null;
    attempt.offQuit = deps.onBeforeQuitForUpdate?.(() => {
      if (!attempt.active) return;
      deps.log?.("update-quit", { version: attempt.version, squirrelDownloaded: attempt.squirrelDownloaded });
      stopHandoff(attempt);
    }) ?? null;
    deps.log?.("update-squirrel-handoff-started", { version });
    attempt.timer = setTimeout(() => {
      if (attempt.squirrelDownloaded) return;
      void failHandoff(attempt, "update-handoff-timeout");
    }, deps.handoffTimeoutMs ?? SQUIRREL_HANDOFF_TIMEOUT_MS);
    attempt.timer.unref?.();
    return attempt;
  }

  function onHandoffError(error: unknown): boolean {
    const attempt = handoff;
    if (!attempt?.active) return false;
    if (attempt.squirrelDownloaded) {
      deps.log?.("update-error-after-squirrel-update-downloaded", {
        version: attempt.version,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      return true;
    }
    void failHandoff(attempt, "update-handoff-error", error);
    return true;
  }

  async function install(): Promise<void> {
    const status = deps.status();
    if (status.phase !== "downloaded") throw new Error("No downloaded update is ready to install.");
    // One ShipIt at a time (#78): overlapping installs are a suspected cause of the silent rollback.
    if (deps.latch.installing) return;
    deps.setPreparingUpdate?.(true);
    let prepared: boolean;
    try {
      prepared = await (deps.preparePlannedUpdate?deps.preparePlannedUpdate():confirmRestart(deps.relaunch, "Restarting to update", deps.ask));
    } catch (error) {
      deps.setPreparingUpdate?.(false);
      throw error;
    }
    if (!prepared) { deps.setPreparingUpdate?.(false); return; }
    if(deps.status().phase!=="downloaded") { await deps.abortPlannedUpdate?.(); deps.setPreparingUpdate?.(false); return; }
    if (deps.latch.installing) return;
    deps.latch.installing = true;
    let attempt: Handoff | null = null;
    try {
      // Before the handoff, since quitAndInstall quits; inside the try so a failed write releases the latch.
      if (status.downloadedVersion) await deps.mark(status.downloadedVersion);
      if (deps.monitorSquirrelHandoff !== false) attempt = beginHandoff(status.downloadedVersion ?? undefined);
      deps.updater.quitAndInstall(false, true);
    } catch (err) {
      // A synchronous handoff failure is observable; the async ShipIt one is caught on the next launch.
      if (attempt) await failHandoff(attempt, "update-handoff-error", err);
      else {
        deps.latch.installing = false;
        deps.setPreparingUpdate?.(false);
        deps.log?.("update-handoff-error", { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
        await deps.abortPlannedUpdate?.().catch(() => {});
        await deps.clearMark().catch(() => {});
        const message = `Couldn't start the update: ${err instanceof Error ? err.message : String(err)}`;
        deps.failed(deps.monitorSquirrelHandoff === false ? message : `${message} ${UPDATE_HANDOFF_FALLBACK}`);
      }
    }
  }

  async function installOnQuit(): Promise<void> {
    const status = deps.status();
    if (!(await ordinaryQuitInstalls(deps.relaunch, status.phase === "downloaded"))) return deps.quit();
    deps.latch.installing = true;
    deps.setPreparingUpdate?.(true);
    try {
      if (status.downloadedVersion) deps.markSync(status.downloadedVersion);
      deps.updater.autoRunAppAfterInstall = false;
      deps.updater.quitAndInstall(false, false);
    } catch {
      deps.latch.installing = false;
      deps.setPreparingUpdate?.(false);
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

  return { install, beforeQuit, onHandoffError };
}

/** On launch with a stale host: restarts it unless that stops work in a pane the user did not agree to stop and
 *  keeps now; true when restarted. An old host whose panes cannot be read is restarted, as before the question. */
export async function restartStaleHost(deps: RelaunchDeps, ask: (text: string) => Promise<boolean>, restart: () => Promise<unknown>): Promise<boolean> {
  if (!(await confirmRestartOnce(deps, "Restarting the terminals for Aya's updated terminal host", ask).catch(() => true))) return false;
  await restart();
  return true;
}
