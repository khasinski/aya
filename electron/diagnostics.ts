// Diagnostics report and GPU-helper recovery. The app, host health, config readers and windows come from main.ts.

import type { App, BrowserWindow, Details } from "electron";
import type { createCliAdoptionStore } from "./cli-adoption";
import type { pathEntries } from "./cli-setup";
import type { listProjects, listProjectState } from "./config";
import type { pathExists } from "./path-exists";
import type { listPresets } from "./presets";
import type { HostHealth } from "./pty-host-health";
import type { PtyLogWriter } from "./pty-log";
import type { CliStatus, DiagnosticsReport } from "./types";
import type { usageHookStatus } from "./usage-hook";

export interface DiagnosticsDeps {
  app: Pick<App, "getVersion">;
  isDev: boolean;
  ayaHome: string;
  controlSocketPath: string;
  remoteSocketPath: string;
  ptyHostSocketPath: string;
  listPresets: typeof listPresets;
  listProjects: typeof listProjects;
  listProjectState: typeof listProjectState;
  usageHookStatus: typeof usageHookStatus;
  cliStatus: () => Promise<CliStatus>;
  hostHealth: () => Promise<HostHealth>;
  cliAdoption: Pick<ReturnType<typeof createCliAdoptionStore>, "summary">;
  pathExists: typeof pathExists;
  pathEntries: typeof pathEntries;
  userScreenRules: () => DiagnosticsReport["userScreenRules"];
}

export interface GpuDeathDeps {
  diagnosticsLog: PtyLogWriter;
  appQuitting: () => boolean;
  eachAyaWindow: (fn: (win: Pick<BrowserWindow, "webContents">) => void) => void;
}

// Cap of $PATH entries returned to the renderer diagnostics view.
const MAX_PATH_ENTRIES_RETURNED = 40;

// Heal nudges after a GPU death: the typical relaunch window, then a safety net
// (a no-op once the WebGL context is live again).
const GPU_HEAL_NUDGE_DELAYS_MS = [1200, 3000];

export async function diagnosticsReport(deps: DiagnosticsDeps): Promise<DiagnosticsReport> {
  const {
    app, isDev: IS_DEV, ayaHome: AYA_HOME, controlSocketPath: CONTROL_SOCKET_PATH,
    remoteSocketPath: REMOTE_SOCKET_PATH, ptyHostSocketPath: PTY_HOST_SOCKET_PATH,
    listPresets, listProjects, listProjectState, usageHookStatus, cliStatus, hostHealth,
    cliAdoption, pathExists, pathEntries, userScreenRules,
  } = deps;
  const [presets, projects, projectState, usageHook, cli, health, adoption] =
    await Promise.all([
      listPresets(),
      listProjects(),
      listProjectState(),
      usageHookStatus(),
      cliStatus(),
      hostHealth(),
      cliAdoption.summary(),
    ]);
  return {
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      mode: IS_DEV ? "development" : "production",
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: process.cwd(),
    },
    paths: {
      ayaHome: AYA_HOME,
      controlSocket: CONTROL_SOCKET_PATH,
      remoteSocket: REMOTE_SOCKET_PATH,
      ptyHostSocket: PTY_HOST_SOCKET_PATH,
      controlSocketExists: await pathExists(CONTROL_SOCKET_PATH),
      remoteSocketExists: await pathExists(REMOTE_SOCKET_PATH),
      ptyHostSocketExists: await pathExists(PTY_HOST_SOCKET_PATH),
    },
    shell: {
      shell: process.env.SHELL ?? null,
      pathEntries: pathEntries().slice(0, MAX_PATH_ENTRIES_RETURNED),
    },
    cli,
    cliAdoption: adoption,
    ptyHost: {
      expected: health.expected,
      actual: health.identity,
      ptyCount: health.ptyCount,
      stale: health.stale,
      pid: health.pid,
      socket: health.socket,
      otherHosts: health.otherHosts,
      warnings: health.warnings,
    },
    presets: presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      agent: preset.agent,
      command: preset.command,
      ...(preset.configDir ? { configDir: preset.configDir } : {}),
      ...(typeof preset.autoResume === "boolean"
        ? { autoResume: preset.autoResume }
        : {}),
      ...(typeof preset.unsafeMode === "boolean"
        ? { unsafeMode: preset.unsafeMode }
        : {}),
      ...(preset.agentBrief ? { agentBrief: true } : {}),
    })),
    projects: {
      total: projects.length,
      open: projectState.open.length,
      recent: projectState.recent.length,
      remote: projects.filter((project) => !!project.remote).length,
    },
    usage: {
      claudeAccounts: presets.filter((preset) => preset.agent === "claude").length,
      codexAccounts: presets.filter((preset) => preset.agent === "codex").length,
      hookInstalled: usageHook.installed,
      hookScriptPath: usageHook.scriptPath,
    },
    userScreenRules: userScreenRules(),
  };
}

// GPU-helper deaths (#79). The OS can quietly kill the GPU process under memory
// pressure (jetsam); every GPU-composited surface of the window then goes white
// until Chromium relaunches it (~1-2s). No renderer code can shorten that
// window, so we do two things: (1) log the death with its reason so a future
// white-flash report is correlated instantly instead of via `ps` archaeology
// (the `reason` field confirms or refutes the memory-pressure theory), and (2)
// once the replacement GPU process should be up, nudge renderers to re-run
// their existing WebGL/PTY repair path - belt-and-suspenders over Chromium's
// own repaint.
export function createGpuDeathHandler(deps: GpuDeathDeps) {
  const { diagnosticsLog, eachAyaWindow } = deps;
  // Live heal timers: a burst of deaths must not accumulate them.
  const gpuHealTimers = new Set<NodeJS.Timeout>();
  function childProcessGone(details: Details): void {
    if (details.type !== "GPU") return;
    // Do not log a clean exit (usually shutdown), but DO heal: a graceful
    // mid-session GPU restart reports clean-exit and still drops WebGL contexts.
    if (details.reason !== "clean-exit") {
      diagnosticsLog.append("gpu-process-gone", {
        reason: details.reason, // killed | crashed | oom | ...
        exitCode: details.exitCode,
      });
    }
    for (const delay of GPU_HEAL_NUDGE_DELAYS_MS) {
      const timer = setTimeout(() => {
        gpuHealTimers.delete(timer);
        if (deps.appQuitting()) return;
        eachAyaWindow((win) => win.webContents.send("gpu:relaunched"));
      }, delay);
      gpuHealTimers.add(timer);
    }
  }

  function clearHealTimers(): void {
    for (const timer of gpuHealTimers) clearTimeout(timer);
    gpuHealTimers.clear();
  }

  return { childProcessGone, clearHealTimers };
}
