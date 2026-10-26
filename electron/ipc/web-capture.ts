// Aya Web (experimental) — capture of ipcMain.handle registrations.
//
// Electron has no API to look up a registered invoke handler, so we wrap
// ipcMain.handle before registerIpc() runs and record every (channel ->
// handler) pair. This registry is broader than the Aya Web API: web-server.ts
// applies its explicit allowlist before dispatch. Allowed handlers are invoked
// with a stub event (sender: null); window-scoped web overrides bypass this.

import type { IpcMain, IpcMainInvokeEvent } from "electron";

type CapturedHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

const captured = new Map<string, CapturedHandler>();

/** Wrap ipcMain.handle so later registrations are recorded. Call once,
 *  before registerIpc(). */
export function captureIpcHandlers(ipcMain: IpcMain): void {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: CapturedHandler) => {
    captured.set(channel, listener);
    return original(channel, listener);
  };
}

export function hasCapturedIpcHandler(channel: string): boolean {
  return captured.has(channel);
}

/** Invoke a captured handler the way ipcMain would, with a windowless stub
 *  event. Throws for unknown channels. */
export async function invokeCapturedIpcHandler(
  channel: string,
  args: unknown[],
  senderId?: number,
): Promise<unknown> {
  const handler = captured.get(channel);
  if (!handler) throw new Error(`Unknown channel: ${channel}`);
  // sender: null — window-scoped channels are overridden before this path.
  const stubEvent = {
    sender: senderId === undefined ? null : { id: senderId },
  } as unknown as IpcMainInvokeEvent;
  return handler(stubEvent, ...args);
}
