// A downloaded update replaces the PTY host: the next launch restarts it, which stops what panes run in the background
// (finding 16). Only a confirmed update or a quit with no such work installs it.

import { backgroundWorkOf, confirmRestartOnce, type RelaunchDeps } from "./relaunch-notes";

/** Whether a quit installs the downloaded update: an explicit one was confirmed before it quit; an ordinary quit
 *  installs only when no pane shows background work, and leaves the update for an explicit, confirmed one otherwise. */
export function quitInstalls({ downloaded, backgroundWork, explicit }: { downloaded: boolean; backgroundWork: boolean; explicit: boolean }): boolean {
  return downloaded && (explicit || !backgroundWork);
}

/** An ordinary quit's choice, read off the panes now; panes that cannot be read count as work. */
export async function ordinaryQuitInstalls(deps: RelaunchDeps, downloaded: boolean): Promise<boolean> {
  if (!downloaded) return false;
  const work = await backgroundWorkOf(deps).catch(() => null);
  return quitInstalls({ downloaded, backgroundWork: work === null || work.length > 0, explicit: false });
}

/** On launch with a stale host: restarts it unless a pane shows background work the user did not agree to stop and
 *  keeps now; true when restarted. An old host whose panes cannot be read is restarted, as before the question. */
export async function restartStaleHost(deps: RelaunchDeps, ask: (text: string) => Promise<boolean>, restart: () => Promise<void>): Promise<boolean> {
  if (!(await confirmRestartOnce(deps, "Restarting the terminals for the new Aya version", ask).catch(() => true))) return false;
  await restart();
  return true;
}
