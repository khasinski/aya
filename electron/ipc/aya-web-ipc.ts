// Aya Web settings IPC: status, configure (on/off, port, listen address, user, password) and a new generated
// password. Owns the server, its config and the queue every change runs in.

import type { App, IpcMain } from "electron";
import type { networkInterfaces } from "node:os";
import type { PtyHostClient } from "../pty-host-client";
import type { WebServerStatus } from "../types";
import type { WebServerHandle, WebServerOptions } from "../web-server";
import {
  generateWebPassword,
  normalizeWebHost,
  normalizeWebPort,
  webCredentials,
  webInterfaceAddresses,
  webServerUrls,
  type WebConfig,
} from "../web-config";

export interface AyaWebDeps {
  app: Pick<App, "getVersion">;
  ptyHost: Pick<PtyHostClient, "attachWebContents" | "detachWebContents">;
  isDev: boolean;
  distDir: string;
  loadWebConfig: () => Promise<WebConfig>;
  saveWebConfig: (next: WebConfig) => Promise<void>;
  startWebServer: (options: WebServerOptions) => Promise<WebServerHandle>;
  networkInterfaces: typeof networkInterfaces;
}

export function createAyaWeb(deps: AyaWebDeps) {
  // --- Aya Web (experimental): browser access over HTTP + WebSocket ---
  let webConfig: WebConfig | null = null;
  let webServer: WebServerHandle | null = null;
  // Last start failure (e.g. port already in use) - surfaced in Settings.
  let webServerError: string | null = null;
  // Every load, change and (re)start of Aya Web runs one after another. Settings exists in each window and in Aya
  // Web itself; two changes at once read the same config, and the later save dropped the other change, or a disable
  // that ran while an enable was still starting found no server to stop and the server came up anyway.
  let webQueue: Promise<unknown> = Promise.resolve();
  function inWebQueue<T>(change: () => Promise<T>): Promise<T> {
    const run = webQueue.then(change);
    webQueue = run.catch(() => undefined);
    return run;
  }
  // Virtual PTY-event sink: fans "pty:event" out to the web clients exactly
  // like a window's webContents. Registered while the server runs.
  const webPtySink = {
    isDestroyed: () => false,
    send: (channel: "pty:event", event: unknown) => {
      webServer?.broadcast(channel, event);
    },
  };

  /** (Re)apply the current web config: stop the running server, then start a
   *  fresh one when enabled. Start failures are recorded, never thrown. */
  async function applyWebServerState(): Promise<void> {
    if (webServer) {
      deps.ptyHost.detachWebContents(webPtySink);
      const closing = webServer;
      webServer = null;
      await closing.close();
    }
    webServerError = null;
    const config = webConfig;
    if (!config || !config.enabled) return;
    try {
      webServer = await deps.startWebServer({
        appVersion: deps.app.getVersion(),
        isDev: deps.isDev,
        distDir: deps.distDir,
        getConfig: () => webConfig ?? config,
      });
      deps.ptyHost.attachWebContents(webPtySink);
    } catch (err) {
      webServerError = err instanceof Error ? err.message : String(err);
    }
  }

  function webStatus(): WebServerStatus {
    const config = webConfig;
    if (!config) {
      return {
        enabled: false,
        running: false,
        port: 0,
        host: "",
        user: "",
        generatedPassword: null,
        urls: [],
        addresses: [],
        clients: 0,
        error: webServerError,
      };
    }
    const interfaces = deps.networkInterfaces();
    return {
      enabled: config.enabled,
      running: webServer !== null,
      port: config.port,
      host: config.host,
      user: config.user,
      generatedPassword: config.generatedPassword ?? null,
      urls: webServerUrls(config, interfaces),
      addresses: webInterfaceAddresses(interfaces),
      clients: webServer?.clientCount() ?? 0,
      error: webServerError,
    };
  }

  const config = async () => (webConfig ??= await deps.loadWebConfig());
  const save = async (next: WebConfig): Promise<void> => {
    await deps.saveWebConfig(next);
    webConfig = next;
  };

  function start(): void {
    // Aya Web (experimental): start the browser-access server when enabled.
    // Off the critical path - a bad config or busy port must not block boot;
    // the failure lands in webServerError and shows up in Settings.
    void inWebQueue(async () => {
      // Settings may have loaded or changed the config already; that one stands.
      if (!webConfig) webConfig = await deps.loadWebConfig();
      await applyWebServerState();
    })
      .catch((err: unknown) => {
        webServerError = err instanceof Error ? err.message : String(err);
      });
  }

  return {
    inWebQueue,
    webPtySink,
    applyWebServerState,
    webStatus,
    config,
    save,
    start,
    broadcast: (channel: string, update: unknown) => void webServer?.broadcast(channel, update),
  };
}

export interface AyaWebIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** Runs one load, change or (re)start of Aya Web after the others. */
  inQueue: <T>(change: () => Promise<T>) => Promise<T>;
  /** The live config, loaded on first use. */
  config: () => Promise<WebConfig>;
  /** Saves `next`, then makes it the live config. */
  save: (next: WebConfig) => Promise<void>;
  /** Starts, stops or restarts the server for the live config. */
  apply: () => Promise<void>;
  status: () => unknown;
}

export function registerAyaWebIpc(deps: AyaWebIpcDeps): void {
  const { ipcMain, inQueue } = deps;
  ipcMain.handle("web:status", () =>
    inQueue(async () => {
      await deps.config();
      return deps.status();
    }),
  );
  ipcMain.handle("web:configure", (_e, req: unknown) => inQueue(async () => {
    if (typeof req !== "object" || req === null) {
      throw new Error("web:configure: request must be an object");
    }
    const r = req as Record<string, unknown>;
    const next: WebConfig = { ...(await deps.config()) };
    if (typeof r.enabled === "boolean") next.enabled = r.enabled;
    if (r.port !== undefined) next.port = normalizeWebPort(r.port);
    if (r.host !== undefined) {
      const host = normalizeWebHost(r.host);
      if (!host) throw new Error("web:configure: host must be an IP address");
      next.host = host;
    }
    if (typeof r.user === "string" && r.user.trim()) {
      next.user = r.user.trim();
    }
    if (typeof r.password === "string" && r.password) {
      // Custom password: store only the hash; the plaintext generated copy
      // (if any) is dropped by webCredentials.
      delete next.generatedPassword;
      Object.assign(next, webCredentials(r.password, false));
    }
    // Saved first: a failed write leaves Aya on the config it serves now, not on one that is neither saved nor
    // served.
    await deps.save(next);
    await deps.apply();
    return deps.status();
  }));
  ipcMain.handle("web:regenerate-password", () => inQueue(async () => {
    const next = { ...(await deps.config()), ...webCredentials(generateWebPassword(), true) };
    await deps.save(next);
    // Existing sessions stay valid; new logins need the new password.
    return deps.status();
  }));
}
