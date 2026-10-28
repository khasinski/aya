import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { App, BrowserWindow, BrowserWindowConstructorOptions, Dialog, IpcMain } from "electron";

export const E2E_HEADLESS_UI_LOG_ENV = "AYA_E2E_HEADLESS_UI_LOG";
export const E2E_HEADLESS_UI_ACTIVE_ENV = "AYA_E2E_HEADLESS_UI_ACTIVE";

type DialogApi = Pick<Dialog,
  | "showMessageBox" | "showMessageBoxSync" | "showErrorBox"
  | "showOpenDialog" | "showOpenDialogSync" | "showSaveDialog" | "showSaveDialogSync"
>;
type WindowConstructor = {
  new(options: BrowserWindowConstructorOptions): Pick<BrowserWindow, "isVisible" | "destroy">;
  prototype: { show?: (...args: unknown[]) => unknown; showInactive?: (...args: unknown[]) => unknown; getTitle?: () => string };
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
type RendererResponse = { message?: string; messagePrefix?: string; response: unknown; sender: unknown };

export interface HeadlessUiEventExpectation { kind: string; detail?: string }
export interface HeadlessUiEventRecord { kind: string; detail?: string; expected?: boolean }

/** Compare unhandled headless requests with exact per-call declarations. */
export function headlessUiEventMismatch(logged: HeadlessUiEventRecord[], expected: HeadlessUiEventExpectation[]): string | null {
  const actual = logged.filter((event) => event.expected !== true)
    .map(({ kind, detail }) => detail === undefined ? { kind } : { kind, detail });
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`;
}

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
  const record = (kind: EventKind, expected = false, detail?: string) => append(logPath, `${JSON.stringify({ kind, ...(detail === undefined ? {} : { detail }), expected, at: new Date().toISOString() })}\n`);
  const rendererResponses = new Map<EventKind, RendererResponse>();
  const headlessWindowOptions = (options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions => {
    if (options.show === false) return options;
    record("window.construct-visible", false, options.title || "(untitled window)");
    return { ...options, show: false };
  };

  if (!alreadyInstalled) {
    routeDialogMethod(deps.dialog, "showMessageBox", "dialog.showMessageBox", (args) => Promise.resolve(messageBoxDefault(args)), record);
    routeDialogMethod(deps.dialog, "showMessageBoxSync", "dialog.showMessageBoxSync", (args) => messageBoxDefault(args).response, record);
    routeDialogMethod(deps.dialog, "showErrorBox", "dialog.showErrorBox", () => undefined, record);
    routeDialogMethod(deps.dialog, "showOpenDialog", "dialog.showOpenDialog", () => Promise.resolve({ canceled: true, filePaths: [] }), record);
    routeDialogMethod(deps.dialog, "showOpenDialogSync", "dialog.showOpenDialogSync", () => undefined, record);
    routeDialogMethod(deps.dialog, "showSaveDialog", "dialog.showSaveDialog", () => Promise.resolve({ canceled: true }), record);
    routeDialogMethod(deps.dialog, "showSaveDialogSync", "dialog.showSaveDialogSync", () => undefined, record);
    routeWindowMethod(deps.BrowserWindow.prototype, "show", "window.show", record);
    routeWindowMethod(deps.BrowserWindow.prototype, "showInactive", "window.showInactive", record);
    routeNotificationMethod(deps.Notification.prototype, record);
    routeObjectMethod(deps.app, "showAboutPanel", "app.showAboutPanel", record, "About panel");
    installed.add(deps.dialog);
  }

  if (deps.ipcMain && !ipcInstalled.has(deps.ipcMain)) {
    const isAyaSender = (sender: unknown) => deps.BrowserWindow.getAllWindows?.().some((win) => {
      try { return !win.isDestroyed() && win.webContents === sender; } catch { return false; }
    }) === true;
    deps.ipcMain.on("e2e:headless-ui-renderer", (event, kind: unknown, message: unknown) => {
      if (!isAyaSender(event.sender)) { event.returnValue = null; return; }
      if (kind === "renderer.alert" || kind === "renderer.confirm" || kind === "renderer.prompt") {
        const detail = String(message ?? "");
        const configured = rendererResponses.get(kind);
        const configuredForSender = configured?.sender === event.sender;
        if (configuredForSender) rendererResponses.delete(kind);
        const matched = configuredForSender && (configured?.message === detail
          || (configured?.messagePrefix !== undefined && detail.startsWith(configured.messagePrefix)));
        record(kind, matched, detail);
        event.returnValue = matched ? configured!.response
          : kind === "renderer.confirm" ? false : kind === "renderer.prompt" ? null : undefined;
      } else {
        event.returnValue = null;
      }
    });
    deps.ipcMain.on("e2e:headless-ui-response", (event, kind: unknown, matcher: unknown, response: unknown) => {
      if (!isAyaSender(event.sender)) { event.returnValue = false; return; }
      const rule = matcher && typeof matcher === "object" ? matcher as { message?: unknown; messagePrefix?: unknown } : {};
      const hasExact = typeof rule.message === "string" && rule.message.length <= 4096;
      const hasPrefix = typeof rule.messagePrefix === "string" && rule.messagePrefix.length > 0 && rule.messagePrefix.length <= 4096;
      if (hasExact === hasPrefix) { event.returnValue = false; return; }
      const match = hasExact ? { message: rule.message as string } : { messagePrefix: rule.messagePrefix as string };
      if (kind === "renderer.alert" && response === undefined) rendererResponses.set(kind, { ...match, response: undefined, sender: event.sender });
      else if (kind === "renderer.confirm" && typeof response === "boolean") rendererResponses.set(kind, { ...match, response, sender: event.sender });
      else if (kind === "renderer.prompt" && (typeof response === "string" || response === null)) rendererResponses.set(kind, { ...match, response, sender: event.sender });
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
  record: (kind: EventKind, expected?: boolean, detail?: string) => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, method);
  let override: ((...args: unknown[]) => unknown) | undefined;
  const overrideCall = new AsyncLocalStorage<{ active: boolean; delegated: boolean; recorded: boolean }>();
  const detail = (args: unknown[]) => {
    if (method === "showErrorBox") return `${String(args[0] ?? "")}: ${String(args[1] ?? "")}`;
    const options = args.at(-1) as { message?: unknown; title?: unknown; detail?: unknown; defaultPath?: unknown } | undefined;
    return String(options?.message ?? options?.detail ?? options?.title ?? options?.defaultPath ?? "(no message)");
  };
  const routed = (...args: unknown[]) => {
    const activeCall = overrideCall.getStore();
    if (activeCall?.active) {
      activeCall.delegated = true;
      activeCall.recorded = true;
      record(kind, false, detail(args));
      return fallback(args);
    }
    const callDetail = detail(args);
    if (!override) { record(kind, false, callDetail); return fallback(args); }
    const call = { active: true, delegated: false, recorded: false };
    let result: unknown;
    try { result = overrideCall.run(call, () => override!.apply(target, args)); }
    catch (error) {
      call.active = false;
      if (!call.recorded) record(kind, !call.delegated, callDetail);
      throw error;
    }
    const finish = () => {
      call.active = false;
      if (!call.recorded) { call.recorded = true; record(kind, !call.delegated, callDetail); }
    };
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).then((value) => { finish(); return value; }, (error) => { finish(); throw error; });
    }
    finish();
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
  prototype: { show?: (...args: unknown[]) => unknown; showInactive?: (...args: unknown[]) => unknown; getTitle?: () => string },
  method: "show" | "showInactive",
  kind: EventKind,
  record: (kind: EventKind, expected?: boolean, detail?: string) => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  Object.defineProperty(prototype, method, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: false,
    value: function (this: { getTitle?: () => string }) { record(kind, false, this.getTitle?.() || "(untitled window)"); return undefined; },
  });
}

function routeNotificationMethod(
  prototype: { show?: (...args: unknown[]) => unknown },
  record: (kind: EventKind, expected?: boolean, detail?: string) => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "show");
  Object.defineProperty(prototype, "show", {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: false,
    value: function (this: { title?: unknown; body?: unknown }) {
      record("notification.show", false, `${String(this.title ?? "")}: ${String(this.body ?? "")}`);
      return undefined;
    },
  });
}

function routeObjectMethod(
  target: object,
  method: string,
  kind: EventKind,
  record: (kind: EventKind, expected?: boolean, detail?: string) => void,
  detail: string,
): void {
  Object.defineProperty(target, method, {
    configurable: true,
    value: (..._args: unknown[]) => { record(kind, false, detail); return undefined; },
  });
}
