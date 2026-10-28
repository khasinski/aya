import { appendFileSync } from "node:fs";
import type { Dialog, IpcMain } from "electron";

export const E2E_HEADLESS_UI_LOG_ENV = "AYA_E2E_HEADLESS_UI_LOG";

type DialogApi = Pick<Dialog, "showMessageBox" | "showErrorBox" | "showOpenDialog">;
type WindowConstructor = { prototype: { show?: (...args: unknown[]) => unknown; showInactive?: (...args: unknown[]) => unknown } };

type EventKind = "dialog.showMessageBox" | "dialog.showErrorBox" | "dialog.showOpenDialog" | "window.show" | "window.showInactive" | "renderer.alert" | "renderer.confirm" | "renderer.prompt";
const installed = new WeakSet<object>();
const ipcInstalled = new WeakSet<object>();

/** In local headless e2e, make every native UI request observable and non-native. */
export function installHeadlessUiRouter(deps: {
  env: NodeJS.ProcessEnv;
  dialog: DialogApi;
  BrowserWindow: WindowConstructor;
  ipcMain?: Pick<IpcMain, "on">;
  append?: (path: string, line: string) => void;
}): void {
  if (deps.env.AYA_E2E_HEADLESS !== "1") return;
  const logPath = deps.env[E2E_HEADLESS_UI_LOG_ENV];
  if (!logPath) throw new Error(`${E2E_HEADLESS_UI_LOG_ENV} is required in headless e2e mode`);
  const alreadyInstalled = installed.has(deps.dialog);
  const append = deps.append ?? ((path, line) => appendFileSync(path, line, { encoding: "utf8", mode: 0o600 }));
  const record = (kind: EventKind, expected = false) => append(logPath, `${JSON.stringify({ kind, expected, at: new Date().toISOString() })}\n`);
  const rendererResponses = new Map<EventKind, unknown>();

  if (!alreadyInstalled) routeDialogMethod(deps.dialog, "showMessageBox", "dialog.showMessageBox", (args) => {
    const options = args.at(-1) as { cancelId?: unknown; defaultId?: unknown } | undefined;
    const cancelId = options?.cancelId;
    const defaultId = options?.defaultId;
    const response = Number.isInteger(cancelId) ? cancelId as number
      : Number.isInteger(defaultId) ? defaultId as number : 0;
    return Promise.resolve({ response, checkboxChecked: false });
  }, record);
  if (!alreadyInstalled) {
    routeDialogMethod(deps.dialog, "showErrorBox", "dialog.showErrorBox", () => undefined, record);
    routeDialogMethod(deps.dialog, "showOpenDialog", "dialog.showOpenDialog", () => Promise.resolve({ canceled: true, filePaths: [] }), record);
    routeWindowMethod(deps.BrowserWindow.prototype, "show", "window.show", record);
    routeWindowMethod(deps.BrowserWindow.prototype, "showInactive", "window.showInactive", record);
    installed.add(deps.dialog);
  }
  if (deps.ipcMain && !ipcInstalled.has(deps.ipcMain)) {
    deps.ipcMain.on("e2e:headless-ui-renderer", (event, kind: unknown) => {
      if (kind === "renderer.alert" || kind === "renderer.confirm" || kind === "renderer.prompt") {
        record(kind, rendererResponses.has(kind));
        event.returnValue = rendererResponses.has(kind) ? rendererResponses.get(kind)
          : kind === "renderer.confirm" ? false : kind === "renderer.prompt" ? null : undefined;
      } else {
        event.returnValue = null;
      }
    });
    deps.ipcMain.on("e2e:headless-ui-response", (event, kind: unknown, response: unknown) => {
      if (kind === "renderer.alert") rendererResponses.set(kind, undefined);
      else if (kind === "renderer.confirm" && typeof response === "boolean") rendererResponses.set(kind, response);
      else if (kind === "renderer.prompt" && (typeof response === "string" || response === null)) rendererResponses.set(kind, response);
      else { event.returnValue = false; return; }
      event.returnValue = true;
    });
    ipcInstalled.add(deps.ipcMain);
  }
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
  const routed = (...args: unknown[]) => {
    if (inOverride) return fallback(args);
    record(kind, !!override);
    if (override) {
      inOverride = true;
      try { return override.apply(target, args); }
      finally { inOverride = false; }
    }
    return fallback(args);
  };
  Object.defineProperty(target, method, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get: () => routed,
    set: (next: unknown) => { override = typeof next === "function" ? next as (...args: unknown[]) => unknown : undefined; },
  });
}

function routeWindowMethod(
  prototype: WindowConstructor["prototype"],
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
