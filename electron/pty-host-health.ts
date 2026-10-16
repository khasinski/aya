// One account of the terminal host's state, for every place that judges it: Aya's launch (is the host stale?), the
// red dot on Restart Aya, and Settings > Diagnostics. On 2026-10-13 a host ran with no pty-host.sock, and a second
// host held duplicate agents no window showed; Diagnostics printed the raw facts without saying either was wrong.

import type { App, BrowserWindow, dialog, Menu, nativeImage } from "electron";
import { readFileSync, existsSync } from "node:fs";
import { OWNER_DIRECTORY } from "./pty-owner-registry";
import * as net from "node:net";
import * as path from "node:path";
import { PTY_HOST_EXIT_WAIT_MS, type PtyHostClient, type HostRestartTarget } from "./pty-host-client";
import { currentProcessesConfirmed, type RelaunchDeps } from "./relaunch-notes";
import { restartStaleHost } from "./updates";
import {handoverPeer} from "./pty-handover-window";
import type {HostAuthenticationProblem} from "./pty-host-auth-status";
import type { HostRecord } from "./pty-host-registry";
import type { PtyOwnerStatus } from "./pty-host-protocol";
import { isHostStale, UNKNOWN_SCRIPT_HASH, type HostIdentity } from "./pty-host-staleness";

/** How long the socket probe waits for the host on pty-host.sock to answer. */
export const SOCKET_PROBE_TIMEOUT_MS = 1_000;

export interface OtherHost {
  pid: number;
  startTime: string;
  version: string;
}

export interface HostHealth {
  /** The host this Aya talks to, or null when it talks to none. */
  pid: number | null;
  startTime?:string|null;
  identity: HostIdentity | null;
  expected: HostIdentity;
  ptyCount: number;
  owner?: PtyOwnerStatus;
  recoveryReason?:string;
  ownerUnavailable?:boolean;
  ownerStopped?:boolean;
  authentication?:HostAuthenticationProblem;
  stale: boolean;
  /** Expected core bytes could not be read: warn, but never restart automatically. */
  indeterminate?: boolean;
  socket: {
    exists: boolean;
    /** The host answering on pty-host.sock, or null when none answers. */
    pid: number | null;
  };
  /** Verified running hosts this Aya does not use and that are not on the socket: their terminals show nowhere. */
  otherHosts: OtherHost[];
  warnings: string[];
}

export interface HostHealthDeps {
  expected: HostIdentity;
  /** Whether this Aya is connected to a host now. */
  connected(): boolean;
  status(): Promise<{ identity: HostIdentity | null; ptyCount: number; pid?: number; startTime?:string|null; owner?: HostHealth["owner"];recoveryReason?:string;ownerUnavailable?:boolean;ownerStopped?:boolean;authentication?:HostAuthenticationProblem }>;
  socketExists(): Promise<boolean>;
  /** The pid of the host answering on pty-host.sock, without starting one; null when none answers. */
  probeSocket(): Promise<number | null>;
  liveRecords(): HostRecord[];
  ownerExists?(): boolean;
}

export async function gatherHostHealth(deps: HostHealthDeps): Promise<HostHealth> {
  const socketExists = await deps.socketExists();
  // Asking a client that is not connected while no socket exists would start a host: there is none to describe.
  const asked = deps.connected() || socketExists || !!deps.ownerExists?.();
  const status = asked ? await deps.status() : { identity: null, ptyCount: 0, pid: undefined };
  const pid = typeof status.pid === "number" ? status.pid : null;
  const socketPid = socketExists ? await deps.probeSocket() : null;
  const known = new Set([pid, socketPid]);
  const otherHosts = deps
    .liveRecords()
    .filter((rec) => !known.has(rec.pid))
    .map((rec) => ({ pid: rec.pid, startTime: rec.startTime, version: rec.version }));
  const health: Omit<HostHealth, "warnings"> = {
    pid,
    ...(status.startTime!==undefined?{startTime:status.startTime}:{}),
    identity: status.identity,
    expected: deps.expected,
    ptyCount: status.ptyCount,
    stale: asked && (isHostStale(deps.expected, status.identity) || !!status.owner?.incompatible),
    ...(status.owner ? { owner: status.owner } : {}),
    ...(status.recoveryReason ? { recoveryReason:status.recoveryReason } : {}),
    ...(status.authentication ? {authentication:status.authentication}:{}),
    ...(status.ownerUnavailable?{ownerUnavailable:true}:{}),
    ...(status.ownerStopped?{ownerStopped:true}:{}),
    indeterminate: asked && (!deps.expected.scriptHash || deps.expected.scriptHash === UNKNOWN_SCRIPT_HASH),
    socket: { exists: socketExists, pid: socketPid },
    otherHosts,
  };
  return { ...health, warnings: hostWarnings(health) };
}

/** What is wrong, in the words Diagnostics shows; empty when nothing is. */
export function hostWarnings(health: Omit<HostHealth, "warnings">): string[] {
  const warnings: string[] = [];
  if(health.recoveryReason)warnings.push(health.recoveryReason);
  if(health.authentication){warnings.push(health.authentication.reason);if(!health.authentication.inventoryKnown)warnings.push("The retained terminal inventory could not be verified; its running processes are unknown.");}
  if (health.indeterminate) {
    warnings.push("The terminal host build cannot be compared: Aya could not read its current PTY runtime files. The running terminals were kept.");
  }
  if (health.owner?.disconnected.length) warnings.push(`${health.owner.disconnected.length} terminals are disconnected from their JS host. Their native owner inventory was kept; restart explicitly to stop them.`);
  if (health.stale&&!health.authentication) {
    warnings.push(
      health.owner?.incompatible ? "The native PTY owner is unavailable or incompatible. Explicit recovery asks before stopping any retained processes."
        : `The terminal host runs different PTY code or runtime (${health.identity?.version ?? "unknown version"}): restart it to use this one.`,
    );
  }
  if (health.pid !== null && !health.socket.exists) {
    warnings.push(
      `The terminal host (pid ${health.pid}) has no pty-host.sock: the next Aya start will start a second host and resume every agent again. Restart the PTY host now.`,
    );
  } else if (health.pid !== null && health.socket.pid !== null && health.socket.pid !== health.pid) {
    warnings.push(
      `pty-host.sock leads to another terminal host (pid ${health.socket.pid}) than the one this Aya uses (pid ${health.pid}).`,
    );
  }
  if (health.otherHosts.length > 0) {
    const pids = health.otherHosts.map((host) => host.pid).join(", ");
    warnings.push(
      health.otherHosts.length === 1
        ? `1 other terminal host still runs (pid ${pids}): its terminals show in no window. Stop it with Stop other hosts.`
        : `${health.otherHosts.length} other terminal hosts still run (pid ${pids}): their terminals show in no window. Stop them with Stop other hosts.`,
    );
  }
  return warnings;
}

/** Kernel peer identity only: sends no RPC, status request, proof or credential. */
export function probeSocketPid(socketPath: string, timeoutMs: number = SOCKET_PROBE_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (pid: number | null) => {
      if (settled) return;
      settled = true;clearTimeout(timer);socket.destroy();resolve(pid);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const socket = net.createConnection(socketPath, () => {
      try{done(handoverPeer(socket).pid);}catch{done(null);}
    });
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

// Delay before re-probing a host that answered the version handshake with
// null - long enough for a slow cold spawn to finish listening.
const STALE_HOST_REPROBE_DELAY_MS = 1_000;

export interface PtyHostHealthDeps {
  app: Pick<App, "getVersion">;
  mainDirname: string;
  ptyHost: Pick<PtyHostClient, "expectedHostIdentity" | "isConnected" | "hostStatus" | "restart">;
  relaunchDeps: RelaunchDeps;
  askRestart: (yes: string, text: string) => Promise<boolean>;
  confirmLosingWork: (action: string, yes: string) => Promise<boolean>;
  focusedAyaWindow: () => BrowserWindow | null;
  dialog: Pick<typeof dialog, "showMessageBox">;
  Menu: Pick<typeof Menu, "getApplicationMenu">;
  nativeImage: Pick<typeof nativeImage, "createEmpty">;
  setStaleMenuIcon: () => void;
  socketExists: () => Promise<boolean>;
  probeSocket: () => Promise<number | null>;
  liveRecords: () => HostRecord[];
  kill: (pid: number, signal: "SIGTERM") => unknown;
  waitForExit: (pid: number, timeoutMs: number) => Promise<boolean>;
}

/** Host health and restart actions share the live stale flag read by the application menu. */
export function createPtyHostHealth(deps: PtyHostHealthDeps) {
  const { app, mainDirname, ptyHost, relaunchDeps, askRestart, confirmLosingWork, focusedAyaWindow,
    dialog, Menu, nativeImage, setStaleMenuIcon, kill, waitForExit } = deps;
  /** The version of the host the client WOULD spawn, from package.json as the host reads it: app.getVersion()
   *  is Electron's own outside a packaged app, and that mismatch killed a current host on every dev/e2e boot. */
  const EXPECTED_HOST_VERSION: string = (() => {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(mainDirname, "..", "package.json"), "utf-8"),
      ) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // fall through to app.getVersion() - correct in packaged builds
    }
    return app.getVersion();
  })();

  // Set to true when a stale PTY host is detected on launch (#28). The Restart
  // Aya menu item reads this flag so it can kill the stale host before relaunching.
  let staleHostDetected = false;

  /** On launch, reap a stale PTY host (#28) even with live terminals, asking first when that stops work in a pane
   *  (a no keeps it, with Restart Aya's red dot). Best-effort; a pre-#73 host may orphan a signal-ignoring child once. */
  async function handleStaleHost(): Promise<void> {
    try {
      let health = await hostHealth();
      if (health.indeterminate) return;
      // A running host this Aya cannot reach (no socket, or another host on it): its terminals show nowhere, and the
      // first pane would start another host and resume every agent a second time. Asked, like any stop of work.
      if (health.otherHosts.length > 0 && (await askStopOtherHosts(health.otherHosts.length, "Aya found"))) {
        await stopHosts(health.otherHosts.map((host) => host.pid));
        health = await hostHealth();
      }
      if(health.authentication){
        if(!await askRestart("Restart terminals",await authRestartDetail(health))){showStaleHost(true);return;}
        const exited=await ptyHost.restart({target:{pid:health.pid,startTime:health.startTime??null,owner:health.owner},confirmChanged:askChangedRestartTarget,confirmSurvivors:askSurvivorRecovery});
        await hostHealth();if(!exited)showStaleHost(true);return;
      }
      if (health.identity === null && health.stale) {
        // identity null is ALSO returned for transient client-side failures (e.g.
        // a >5s cold-spawn socket wait). Acting on it immediately would shut down
        // the freshly-spawned, current-version host. Re-probe once after a short
        // delay: a genuinely ancient host fails the version request consistently,
        // while a slow spawn answers with a matching identity the second time.
        await new Promise((resolve) => setTimeout(resolve, STALE_HOST_REPROBE_DELAY_MS));
        health = await hostHealth();
      }
      if (!health.stale) return;
      // The update is in, but the panes' work still runs on the old host: ask, unless Restart to update did.
      let exited = true;
      let asked = false, cancelled = false;
      if (
        !(await restartStaleHost(relaunchDeps, (text) => { asked = true; return askRestart("Restart terminals", text); }, async () => {
          const migration = !health.owner && health.ptyCount > 0;
          if (!asked && (migration || health.owner?.incompatible) && !(await currentProcessesConfirmed(relaunchDeps, health.ptyCount).catch(() => false))) {
            const detail = migration ? "Moving these terminals to Aya's native PTY owner stops their current processes. They cannot be moved from the older host."
              : "Replacing the unavailable or incompatible native PTY owner stops every terminal it owns.";
            if (!(await askRestart("Restart terminals", detail))) { cancelled = true; return; }
          }
          exited = await ptyHost.restart({target:{pid:health.pid,startTime:health.startTime??null,owner:health.owner},confirmChanged:askChangedRestartTarget,confirmSurvivors:askSurvivorRecovery});
        }))
      ) {
        showStaleHost(true);
        return;
      }
      if (cancelled) { showStaleHost(true); return; }
      // restart() swallows request errors by design (an old host may not honor
      // "shutdown"), so returning is NOT proof the host died. Verify: re-probe the
      // socket; a fresh current-version host (or none yet) means success, the SAME
      // stale identity answering again means the reap failed.
      // hostHealth() keeps the red dot on when the reap didn't take, and an old host still running past the wait keeps
      // it too, so the user can retry. The menu may not be installed yet (this runs before createWindow), so the
      // caller applies the icon from the flag after installApplicationMenu.
      await hostHealth();
      if (!exited) showStaleHost(true);
    } catch {
      // best-effort; a host that can't be queried is handled on next use
    }
  }

  /** The terminal host's state, the one account behind Aya's launch check, the Restart Aya red dot and Diagnostics. */
  async function hostHealth(): Promise<HostHealth> {
    const health = await gatherHostHealth({
      expected: ptyHost.expectedHostIdentity(EXPECTED_HOST_VERSION),
      ownerExists: () => existsSync(path.join(OWNER_DIRECTORY, "record.json")),
      connected: () => ptyHost.isConnected(),
      status: async () => ptyHost.hostStatus((await relaunchDeps.panes().catch(()=>[])).map(p=>p.id)),
      socketExists: () => deps.socketExists(),
      probeSocket: () => deps.probeSocket(),
      liveRecords: () => deps.liveRecords(),
    });
    showStaleHost(health.stale || health.indeterminate === true);
    return health;
  }

  /** Asks before ending the terminals of hosts this Aya does not use. */
  async function askStopOtherHosts(count: number, who: string): Promise<boolean> {
    const hosts = count === 1 ? "another terminal host" : `${count} other terminal hosts`;
    const options = {
      type: "warning" as const,
      buttons: ["Stop", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: count === 1 ? "Stop the other terminal host?" : `Stop ${count} other terminal hosts?`,
      detail: `${who} ${hosts} still running from before. Their terminals show in no window, and Aya would resume those agents again in its own host. Stopping ends them.`,
    };
    const parent = focusedAyaWindow();
    return (await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))).response === 0;
  }

  /** SIGTERM, so each host's own shutdown ends its terminals and removes its registry record; answers once they are
   *  gone, so a refreshed report no longer lists them. */
  async function stopHosts(pids: number[]): Promise<number[]> {
    // Checked again right before the signal: a host may have exited, and its pid passed on, while Aya asked.
    const stillHosts = new Set(deps.liveRecords().map((rec) => rec.pid));
    const stopped: number[] = [];
    for (const pid of pids.filter((p) => stillHosts.has(p))) {
      try {
        kill(pid, "SIGTERM");
        stopped.push(pid);
      } catch {
        // already gone
      }
    }
    await Promise.all(stopped.map((pid) => waitForExit(pid, PTY_HOST_EXIT_WAIT_MS)));
    return stopped;
  }

  /** The red dot on Restart Aya follows the host's state: on while it is stale, off once it is not. */
  function showStaleHost(stale: boolean): void {
    staleHostDetected = stale;
    if (stale) {
      setStaleMenuIcon();
      return;
    }
    const item = Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
    if (item) item.icon = nativeImage.createEmpty();
  }

  async function authRestartDetail(target:Pick<HostRestartTarget,"pid"|"owner"|"authentication">):Promise<string>{
    const names=new Map((await relaunchDeps.panes().catch(()=>[])).map(p=>[p.id,p.name]));
    const retained=[...(target.owner?.inventory??[]).map(p=>`${names.get(p.id)??p.id} (PID ${p.pid})`),...(target.owner?.uncertain??[]).map(id=>`${names.get(id)??id}: process identity unknown`)];
    const legacy=target.authentication?.legacy;
    const reported=legacy?.reportedIds.map(id=>`${names.get(id)??id} (reported by the old host; child PID unavailable)`)??[];
    return (legacy?"The older terminal host does not support socket authentication. Restarting it stops its current processes.":"Aya could not authenticate to this terminal host. Restarting it stops its current processes.")+
      (target.pid?`\n\nTerminal host PID ${target.pid}.`:"\n\nThe terminal host identity is unknown; nothing can be stopped safely.")+
      (retained.length?`\n\nProcesses that may still run:\n${retained.join("\n")}`:"")+
      (legacy?`\n\nReported by the old host:\n${[...reported,...(legacy.unknownCount?[`${legacy.unknownCount} more unknown`]:[])].join("\n")||"No running panes reported."}`:!target.authentication?.inventoryKnown?"\n\nThe retained process inventory is unknown. It must not be treated as empty.":"");
  }
  async function unavailableOwnerDetail(target:Pick<HostRestartTarget,"owner"|"recoveryReason">):Promise<string>{
    const names=new Map((await relaunchDeps.panes().catch(()=>[])).map(p=>[p.id,p.name]));
    const retained=[...(target.owner?.inventory??[]).map(p=>`${names.get(p.id)??p.id} (PID ${p.pid})`),...(target.owner?.uncertain??[]).map(id=>`${names.get(id)??id}: process identity unknown`)];
    return "Stopping the terminal owner"+(target.owner?` (PID ${target.owner.pid})`:"")+" ends its panes. The JS terminal host is unavailable. Surviving processes require a separate confirmation."+
      (retained.length?`\n\nProcesses that may still run:\n${retained.join("\n")}`:target.owner?"\n\nNo pane processes were recorded.":"\n\nThe retained process inventory is unknown.")+
      (!target.owner?.startIdentity?"\n\nThe owner's kernel start identity was not recorded. Aya cannot stop it safely; nothing will be signalled.":"")+
      (target.recoveryReason?`\n\n${target.recoveryReason}`:"");
  }
  async function askSurvivorRecovery(target:HostRestartTarget):Promise<boolean>{
    const names=new Map((await relaunchDeps.panes().catch(()=>[])).map(p=>[p.id,p.name]));
    const retained=[...(target.owner?.inventory??[]).map(p=>`${names.get(p.id)??p.id} (PID ${p.pid})`),...(target.owner?.uncertain??[]).map(id=>`${names.get(id)??id}: process identity unknown`),...(target.owner?.recoveryFailures??[])];
    return askRestart("Stop surviving processes","The terminal owner has stopped. These retained processes may still run. Stop only the processes whose recorded identities can still be verified?"+(retained.length?`\n\n${retained.join("\n")}`:"\n\nTheir identities are unknown; unverified processes will not be signalled."));
  }
  async function askChangedRestartTarget(target:HostRestartTarget):Promise<boolean>{
    if(target.ownerUnavailable)return askRestart("Stop terminal owner",await unavailableOwnerDetail(target));
    if(target.authentication)return askRestart("Restart","The terminal host changed after the previous question.\n\n"+await authRestartDetail(target));
    const names=new Map((await relaunchDeps.panes().catch(()=>[])).map(p=>[p.id,p.name]));
    const retained=[...(target.owner?.inventory??[]).map(p=>`${names.get(p.id)??p.id} (PID ${p.pid})`),...(target.owner?.uncertain??[]).map(id=>`${names.get(id)??id}: process identity unknown`)];
    return askRestart("Restart","The terminal host changed after the previous question. Restarting this host stops its current work."+
      (target.pid?`\n\nTerminal host PID ${target.pid}; ${target.ptyCount} panes.`:"\n\nThe current host identity cannot be verified; nothing will be stopped.")+
      (retained.length?`\n\nProcesses that may still run:\n${retained.join("\n")}`:""));
  }

  /** Settings > Diagnostics > PTY host > Restart (and Aya Web): asks, then replaces the host. Throws when cancelled,
   *  or when the old host did not exit, so the window leaves its panes as they are. */
  async function restartHostFromWindow(): Promise<void> {
    const before = await hostHealth();
    const legacy = !before.owner && before.ptyCount > 0;
    const recovery = !!before.ownerUnavailable || !!before.authentication || legacy || before.owner?.incompatible || !!before.owner?.disconnected.length;
    const names = new Map((await relaunchDeps.panes().catch(() => [])).map(p => [p.id, p.name]));
    const retained = [
      ...(before.owner?.inventory ?? []).map(p => `${names.get(p.id) ?? p.id} (PID ${p.pid})`),
      ...(before.owner?.uncertain ?? []).map(id => `${names.get(id) ?? id}: unconfirmed spawn, process identity unknown`),
    ];
    const confirmed = before.ownerUnavailable&&before.ownerStopped?true:before.ownerUnavailable?await askRestart("Stop terminal owner",await unavailableOwnerDetail(before)):before.authentication?await askRestart("Restart",await authRestartDetail(before)):recovery ? await askRestart("Restart", legacy
      ? "Moving these terminals to Aya's native PTY owner stops their current processes. They cannot be moved from the older host."
      : "Restarting the terminal host stops the processes retained by the native PTY owner. Their disconnected screens cannot show all current work." +
        (retained.length ? `\n\nProcesses that may still run:\n${retained.join("\n")}` : ""))
      : await confirmLosingWork("Restarting the PTY host", "Restart");
    if (!confirmed) throw new Error("restart cancelled");
    const exited = await ptyHost.restart({target:{pid:before.pid,startTime:before.startTime??null,owner:before.owner},confirmChanged:askChangedRestartTarget,confirmSurvivors:askSurvivorRecovery});
    // The red dot follows what the host now is: off for a current host, still on if the restart did not take.
    const after = await hostHealth();
    if (recovery && (after.stale || after.owner?.disconnected.length)) {
      showStaleHost(true);
      const left = [...(after.owner?.inventory ?? []).map(p => `${names.get(p.id) ?? p.id} (PID ${p.pid})`), ...(after.owner?.uncertain ?? [])];
      throw new Error(`Some terminal processes could not be confirmed stopped. Their disconnected inventory was kept${left.length ? `: ${left.join(", ")}` : "."}` +
        (after.owner?.recoveryFailures?.length ? `\n\n${after.owner.recoveryFailures.join("\n")}` : ""));
    }
    if (!exited) {
      showStaleHost(true);
      throw new Error(
        `The old terminal host did not exit within ${PTY_HOST_EXIT_WAIT_MS / 1000} s; its terminals may still run. Settings > Diagnostics lists it, with Stop other hosts.`,
      );
    }
  }

  /** Settings > Diagnostics > Stop other hosts: hosts Aya does not use and that are not on the socket, re-verified now
   *  and asked about here, not in the window (Aya Web reaches this too). */
  async function stopOtherHostsFromWindow(): Promise<number[]> {
    const health = await hostHealth();
    if (health.otherHosts.length === 0) return [];
    if (!(await askStopOtherHosts(health.otherHosts.length, "Settings found"))) return [];
    return stopHosts(health.otherHosts.map((host) => host.pid));
  }

  return { EXPECTED_HOST_VERSION, handleStaleHost, hostHealth, restartHostFromWindow, stopOtherHostsFromWindow,
    staleHostDetected: () => staleHostDetected, keepStaleHost:()=>showStaleHost(true) };
}
