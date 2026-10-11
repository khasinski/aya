// A downloaded update replaces the PTY host: the next launch restarts it, which stops what panes run in the background
// (finding 16). Only a confirmed update or a quit with no such work installs it.

import { backgroundWorkKnown, confirmRestart, confirmRestartOnce, type RelaunchDeps } from "./relaunch-notes";

/** An ordinary quit's choice, read off the panes now; a running pane that cannot be read counts as work. */
export async function ordinaryQuitInstalls(deps: RelaunchDeps, downloaded: boolean): Promise<boolean> {
  if (!downloaded) return false;
  const work = await backgroundWorkKnown(deps).catch(() => null);
  return work !== null && work.length === 0;
}

export interface UpdateInstallDeps {
  status: () => { phase: string; downloadedVersion?: string | null };
  relaunch: RelaunchDeps;
  /** The native question before Restart to update stops background work. */
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

/** On launch with a stale host: restarts it unless a pane shows background work the user did not agree to stop and
 *  keeps now; true when restarted. An old host whose panes cannot be read is restarted, as before the question. */
export async function restartStaleHost(deps: RelaunchDeps, ask: (text: string) => Promise<boolean>, restart: () => Promise<void>): Promise<boolean> {
  if (!(await confirmRestartOnce(deps, "Restarting the terminals for the new Aya version", ask).catch(() => true))) return false;
  await restart();
  return true;
}
