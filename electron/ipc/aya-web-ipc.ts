// Aya Web settings IPC: status, configure (on/off, port, listen address, user, password) and a new generated
// password. The server, its config and the queue every change runs in stay with their owner in main.ts.

import type { IpcMain } from "electron";
import {
  generateWebPassword,
  normalizeWebHost,
  normalizeWebPort,
  webCredentials,
  type WebConfig,
} from "../web-config";

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
