import { appendFileSync } from "node:fs";
import type { App, BrowserWindow, BrowserWindowConstructorOptions, Dialog, IpcMain } from "electron";

export const E2E_HEADLESS_UI_LOG_ENV = "AYA_E2E_HEADLESS_UI_LOG";
export const E2E_HEADLESS_UI_ACTIVE_ENV = "AYA_E2E_HEADLESS_UI_ACTIVE";

type DialogApi = Pick<Dialog,
  | "showMessageBox" | "showMessageBoxSync" | "showErrorBox"
  | "showOpenDialog" | "showOpenDialogSync" | "showSaveDialog" | "showSaveDialogSync"
>;
type WindowConstructor = {
  new(options: BrowserWindowConstructorOptions): Pick<BrowserWindow, "isVisible" | "destroy">;
  prototype: { show?: (...args: unknown[]) => unknown; showInactive?: (...args: unknown[]) => unknown };
  getAllWindows?: () => Array<Pick<BrowserWindow, "webContents" | "isDestroyed">>;
};
type NotificationClass = { prototype: { show?: (...args: unknown[]) => unknown } };
type EventKind =
  | "dialog.showMessageBox" | "dialog.showMessageBoxSync" | "dialog.showErrorBox"
  | "dialog.showOpenDialog" | "dialog.showOpenDialogSync" | "dialog.showSaveDialog" | "dialog.showSaveDialogSync"
  | "window.show" | "window.showInactive" | "window.construct-visible" | "app.showAboutPanel" | "notification.show"
  | "renderer.alert" | "renderer.confirm" | "renderer.prompt";

const installed = new WeakSet<object>();
const ipcInstalled = new WeakSet<object>();

/** In unpackaged headless e2e, route every native UI request to a log and a safe default. */
export function installHeadlessUiRouter(deps: {
  env: NodeJS.ProcessEnv;
  app: Pick<App, "isPackaged" | "showAboutPanel">;
  dialog: DialogApi;
  BrowserWindow: WindowConstructor;
  Notification: NotificationClass;
  ipcMain?: Pick<IpcMain, "on">;
  append?: (path: string, line: string) => void;
}): (options: BrowserWindowConstructorOptions) => BrowserWindowConstructorOptions {
  // Packaged apps must not gain test controls from inherited environment.
  delete deps.env[E2E_HEADLESS_UI_ACTIVE_ENV];
  if (deps.app.isPackaged || deps.env.AYA_E2E_HEADLESS !== "1") return (options) => options;
  const logPath = deps.env[E2E_HEADLESS_UI_LOG_ENV];
  if (!logPath) throw new Error(`${E2E_HEADLESS_UI_LOG_ENV} is required in headless e2e mode`);
  deps.env[E2E_HEADLESS_UI_ACTIVE_ENV] = "1";

  const alreadyInstalled = installed.has(deps.dialog);
  const append = deps.append ?? ((path, line) => appendFileSync(path, line, { encoding: "utf8", mode: 0o600 }));
  const record = (kind: EventKind, expected = false) => append(logPath, `${JSON.stringify({ kind, expected, at: new Date().toISOString() })}\n`);
  const rendererResponses = new Map<EventKind, unknown>();
  const headlessWindowOptions = (options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions => {
    if (options.show === false) return options;
    record("window.construct-visible");
    return { ...options, show: false };
  };

  if (!alreadyInstalled) {
    routeDialogMethod(deps.dialog, "showMessageBox", "dialog.showMessageBox", (args) => messageBoxDefault(args), record);
    routeDialogMethod(deps.dialog, "showMessageBoxSync", "dialog.showMessageBoxSync", (args) => messageBoxDefault(args).response, record);
    routeDialogMethod(deps.dialog, "showErrorBox", "dialog.showErrorBox", () => undefined, record);
    routeDialogMethod(deps.dialog, "showOpenDialog", "dialog.showOpenDialog", () => Promise.resolve({ canceled: true, filePaths: [] }), record);
    routeDialogMethod(deps.dialog, "showOpenDialogSync", "dialog.showOpenDialogSync", () => undefined, record);
    routeDialogMethod(deps.dialog, "showSaveDialog", "dialog.showSaveDialog", () => Promise.resolve({ canceled: true }), record);
    routeDialogMethod(deps.dialog, "showSaveDialogSync", "dialog.showSaveDialogSync", () => undefined, record);
    routeWindowMethod(deps.BrowserWindow.prototype, "show", "window.show", record);
    routeWindowMethod(deps.BrowserWindow.prototype, "showInactive", "window.showInactive", record);
    routeWindowMethod(deps.Notification.prototype, "show", "notification.show", record);
    routeObjectMethod(deps.app, "showAboutPanel", "app.showAboutPanel", record);
    installed.add(deps.dialog);
  }

  if (deps.ipcMain && !ipcInstalled.has(deps.ipcMain)) {
    const isAyaSender = (sender: unknown) => deps.BrowserWindow.getAllWindows?.().some((win) => {
      try { return !win.isDestroyed() && win.webContents === sender; } catch { return false; }
    }) === true;
    deps.ipcMain.on("e2e:headless-ui-renderer", (event, kind: unknown) => {
      if (!isAyaSender(event.sender)) { event.returnValue = null; return; }
      if (kind === "renderer.alert" || kind === "renderer.confirm" || kind === "renderer.prompt") {
        record(kind, rendererResponses.has(kind));
        event.returnValue = rendererResponses.has(kind) ? rendererResponses.get(kind)
          : kind === "renderer.confirm" ? false : kind === "renderer.prompt" ? null : undefined;
      } else if (kind === "window.construct-visible") {
        const probe = new deps.BrowserWindow(headlessWindowOptions({ width: 100, height: 100, show: true }));
        event.returnValue = probe.isVisible();
        probe.destroy();
      } else {
        event.returnValue = null;
      }
    });
    deps.ipcMain.on("e2e:headless-ui-response", (event, kind: unknown, response: unknown) => {
      if (!isAyaSender(event.sender)) { event.returnValue = false; return; }
      if (kind === "renderer.alert") rendererResponses.set(kind, undefined);
      else if (kind === "renderer.confirm" && typeof response === "boolean") rendererResponses.set(kind, response);
      else if (kind === "renderer.prompt" && (typeof response === "string" || response === null)) rendererResponses.set(kind, response);
      else { event.returnValue = false; return; }
      event.returnValue = true;
    });
    ipcInstalled.add(deps.ipcMain);
  }

  return headlessWindowOptions;
}
function messageBoxDefault(args: unknown[]): { response: number; checkboxChecked: false } {
  const options = args.at(-1) as { cancelId?: unknown; defaultId?: unknown } | undefined;
  const cancelId = options?.cancelId;
  const defaultId = options?.defaultId;
  const response = Number.isInteger(cancelId) ? cancelId as number
    : Number.isInteger(defaultId) ? defaultId as number : 0;
  return { response, checkboxChecked: false };
}

function routeDialogMethod<K extends keyof DialogApi>(
  target: DialogApi,
  method: K,
  kind: EventKind,
  fallback: (args: unknown[]) => unknown,
  record: (kind: EventKind, expected?: boolean) => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  let override: ((...args: unknown[]) => unknown) | undefined;
  let inOverride = false;
  let overrideFellThrough = false;
  const routed = (...args: unknown[]) => {
    if (inOverride) { overrideFellThrough = true; return fallback(args); }
    if (!override) { record(kind, false); return fallback(args); }
    overrideFellThrough = false;
    inOverride = true;
    let result: unknown;
    try { result = override.apply(target, args); }
    finally { inOverride = false; }
    record(kind, !overrideFellThrough);
    return result;
  };
  Object.defineProperty(target, method, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get: () => routed,
    set: (next: unknown) => { override = typeof next === "function" ? next as (...args: unknown[]) => unknown : undefined; },
  });
}

function routeWindowMethod(
  prototype: { show?: (...args: unknown[]) => unknown; showInactive?: (...args: unknown[]) => unknown },
  method: "show" | "showInactive",
  kind: EventKind,
  record: (kind: EventKind, expected?: boolean) => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  Object.defineProperty(prototype, method, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: false,
    value: (..._args: unknown[]) => { record(kind, false); return undefined; },
  });
}

function routeObjectMethod(
  target: object,
  method: string,
  kind: EventKind,
  record: (kind: EventKind, expected?: boolean) => void,
): void {
  Object.defineProperty(target, method, {
    configurable: true,
    value: (..._args: unknown[]) => { record(kind, false); return undefined; },
  });
}
