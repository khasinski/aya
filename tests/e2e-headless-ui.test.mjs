import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { installHeadlessUiRouter, headlessUiEventMismatch } = await import("../dist-electron/e2e-headless-ui.js");

test("headless UI routing records and suppresses every native dialog and BrowserWindow show path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "ui.jsonl");
  const native = [];
  const rendererHandlers = new Map();
  const ipcMain = { on: (channel, handler) => { rendererHandlers.set(channel, handler); } };
  const app = { isPackaged: false, showAboutPanel() { native.push("about"); } };
  class FakeWindow {
    static windows = [];
    static getAllWindows() { return this.windows; }
    constructor(options = {}) {
      this.options = options;
      this.visible = options.show !== false;
      this.webContents = {};
      FakeWindow.windows.push(this);
    }
    show() { native.push("show"); }
    showInactive() { native.push("showInactive"); }
    isVisible() { return this.visible; }
    hide() { this.visible = false; }
    isDestroyed() { return false; }
  }
  const dialog = {
    async showMessageBox() { native.push("showMessageBox"); return { response: 0, checkboxChecked: false }; },
    showMessageBoxSync() { native.push("showMessageBoxSync"); return 0; },
    showErrorBox() { native.push("showErrorBox"); },
    async showOpenDialog() { native.push("showOpenDialog"); return { canceled: false, filePaths: ["/should-not-open"] }; },
    showOpenDialogSync() { native.push("showOpenDialogSync"); return ["/should-not-open"]; },
    async showSaveDialog() { native.push("showSaveDialog"); return { canceled: false, filePath: "/should-not-save" }; },
    showSaveDialogSync() { native.push("showSaveDialogSync"); return "/should-not-save"; },
  };
  class FakeNotification { show() { native.push("notification"); } }
  const windowOptions = installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: logPath }, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification, ipcMain });

  const original = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = async (...args) => args.at(-1)?.message === "expected test prompt"
    ? { response: 0, checkboxChecked: false }
    : original(...args);
  assert.deepEqual(await dialog.showMessageBox({ message: "expected test prompt" }), { response: 0, checkboxChecked: false });
  assert.deepEqual(await dialog.showMessageBox({ cancelId: 2 }), { response: 2, checkboxChecked: false });
  assert.equal(dialog.showMessageBoxSync({ cancelId: 3 }), 3);
  dialog.showErrorBox("title", "body");
  assert.deepEqual(await dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
  assert.equal(dialog.showOpenDialogSync({}), undefined);
  assert.deepEqual(await dialog.showSaveDialog({}), { canceled: true });
  assert.equal(dialog.showSaveDialogSync({}), undefined);
  new FakeWindow({ show: false }).show();
  new FakeWindow({ show: false }).showInactive();
  const visible = new FakeWindow(windowOptions({ show: true }));
  assert.equal(visible.isVisible(), false);
  app.showAboutPanel();
  new FakeNotification().show();
  const event = { sender: FakeWindow.windows[0].webContents, returnValue: "unset" };
  rendererHandlers.get("e2e:headless-ui-renderer")(event, "renderer.alert");
  assert.equal(event.returnValue, undefined);
  const untrusted = { sender: {}, returnValue: "unset" };
  rendererHandlers.get("e2e:headless-ui-renderer")(untrusted, "renderer.confirm");
  assert.equal(untrusted.returnValue, null, "non-Aya senders cannot invoke the test dialog bridge");
  assert.deepEqual(native, [], "headless routing must never call the native dialog/window APIs");
  assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind), [
    "dialog.showMessageBox", "dialog.showMessageBox", "dialog.showMessageBoxSync", "dialog.showErrorBox",
    "dialog.showOpenDialog", "dialog.showOpenDialogSync", "dialog.showSaveDialog", "dialog.showSaveDialogSync",
    "window.show", "window.showInactive", "window.construct-visible", "app.showAboutPanel", "notification.show", "renderer.alert",
  ]);
});

test("headless mode refuses to start its UI router without an event log", () => {
  class FakeWindow { show() {} showInactive() {} }
  class FakeNotification { show() {} }
  const dialog = { showMessageBox() {}, showErrorBox() {}, showOpenDialog() {} };
  const app = { isPackaged: false, showAboutPanel() {}, on() {} };
  assert.throws(() => installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1" }, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification }), /AYA_E2E_HEADLESS_UI_LOG is required/);
});

test("a router preloaded before main later attaches renderer dialog IPC", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-preload-"));
  try {
    class FakeWindow {
      static windows = [];
      static getAllWindows() { return this.windows; }
      constructor() { this.webContents = {}; FakeWindow.windows.push(this); }
      isDestroyed() { return false; }
      show() {} showInactive() {}
    }
    class FakeNotification { show() {} }
    const dialog = { showMessageBox() {}, showErrorBox() {}, showOpenDialog() {} };
    const env = { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: join(dir, "ui.jsonl") };
    const app = { isPackaged: false, showAboutPanel() {}, on() {} };
    installHeadlessUiRouter({ env, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification });
    const handlers = new Map();
    installHeadlessUiRouter({ env, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification, ipcMain: { on: (channel, callback) => { handlers.set(channel, callback); } } });
    new FakeWindow();
    const event = { sender: FakeWindow.windows[0].webContents, returnValue: "unset" };
    handlers.get("e2e:headless-ui-renderer")(event, "renderer.confirm");
    assert.equal(event.returnValue, false);
    assert.equal(readFileSync(env.AYA_E2E_HEADLESS_UI_LOG, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaged apps ignore inherited headless env and expose no renderer controls", () => {
  class FakeWindow { static getAllWindows() { return []; } show() {} showInactive() {} }
  class FakeNotification { show() {} }
  const env = { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: "/must-not-write", AYA_E2E_HEADLESS_UI_ACTIVE: "1" };
  const dialog = { showMessageBox() { throw new Error("router must not install"); }, showErrorBox() {}, showOpenDialog() {} };
  const app = { isPackaged: true, showAboutPanel() {}, on() {} };
  const handlers = [];
  installHeadlessUiRouter({ env, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification, ipcMain: { on: (...args) => handlers.push(args) } });
  assert.equal(env.AYA_E2E_HEADLESS_UI_ACTIVE, undefined);
  assert.throws(() => dialog.showMessageBox(), /router must not install/);
  assert.deepEqual(handlers, []);
});

test("a targeted dialog override is expected only when it handles the request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-fallthrough-"));
  try {
    const logPath = join(dir, "ui.jsonl");
    const native = [];
    class FakeWindow { static getAllWindows() { return []; } show() {} showInactive() {} }
    class FakeNotification { show() {} }
    const app = { isPackaged: false, showAboutPanel() {}, on() {} };
    const dialog = { async showMessageBox(options) { native.push(options.message); return { response: 1 }; }, showErrorBox() {}, showOpenDialog() {} };
    installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: logPath }, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification });
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => args.at(-1)?.message === "expected prompt"
      ? { response: 0, checkboxChecked: false }
      : original(...args);
    await dialog.showMessageBox({ message: "expected prompt" });
    await dialog.showMessageBox({ message: "unexpected prompt" });
    assert.deepEqual(native, [], "delegated fallthrough is still canceled by the router");
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).expected), [true, false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("async dialog overrides that await before delegating are recorded as unhandled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-async-fallthrough-"));
  try {
    const logPath = join(dir, "ui.jsonl");
    const native = [];
    class FakeWindow { static getAllWindows() { return []; } show() {} showInactive() {} }
    class FakeNotification { show() {} }
    const app = { isPackaged: false, showAboutPanel() {}, on() {} };
    const dialog = { async showMessageBox(options) { native.push(options.message); return { response: 1 }; }, showErrorBox() {}, showOpenDialog() {} };
    installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: logPath }, app, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification });
    const original = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = async (...args) => {
      await Promise.resolve();
      return original(...args);
    };
    await dialog.showMessageBox({ message: "unexpected async delegation" });
    assert.deepEqual(native, [], "the delegated original stays suppressed");
    assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).expected), [false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("async native dialog fallbacks preserve their Promise APIs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-promises-"));
  try {
    class FakeWindow { static getAllWindows() { return []; } show() {} showInactive() {} }
    class FakeNotification { show() {} }
    const dialog = { async showMessageBox() { throw Error("native called"); }, async showSaveDialog() { throw Error("native called"); }, showErrorBox() {}, showOpenDialog() {} };
    installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: join(dir, "ui.jsonl") }, app: { isPackaged: false, showAboutPanel() {}, on() {} }, dialog, BrowserWindow: FakeWindow, Notification: FakeNotification });
    const message = dialog.showMessageBox({ cancelId: 2 });
    const save = dialog.showSaveDialog({});
    assert.equal(message instanceof Promise, true);
    assert.equal(save instanceof Promise, true);
    assert.deepEqual(await message, { response: 2, checkboxChecked: false });
    assert.deepEqual(await save, { canceled: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unexpected headless event makes the fixture's shared check fail", () => {
  assert.match(headlessUiEventMismatch([
    { kind: "dialog.showMessageBox", detail: "unexpected prompt", expected: false },
  ], []), /unexpected prompt/);
  assert.equal(headlessUiEventMismatch([
    { kind: "dialog.showMessageBox", detail: "declared prompt", expected: false },
  ], [{ kind: "dialog.showMessageBox", detail: "declared prompt" }]), null);
  assert.match(headlessUiEventMismatch([
    { kind: "dialog.showMessageBox", detail: "different prompt", expected: false },
  ], [{ kind: "dialog.showMessageBox", detail: "declared prompt" }]), /different prompt/);
});

test("main installs the router before app windows and all Electron e2e launches use the shared headless gate", () => {
  const main = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.match(main, /installHeadlessUiRouter\(\{\s*env:\s*process\.env,\s*app,\s*dialog,\s*BrowserWindow,\s*Notification,\s*ipcMain\s*\}\)/);
  assert.ok(main.indexOf("installHeadlessUiRouter(") < main.indexOf("createAyaWindows("), "router must install before creating any Aya window");
  const preload = readFileSync(join(root, "electron/preload.ts"), "utf8");
  assert.match(preload, /E2E_HEADLESS_UI_ACTIVE_ENV[\s\S]*executeInMainWorld[\s\S]*window\.alert[\s\S]*renderer\.alert/);
  const router = readFileSync(join(root, "electron/e2e-headless-ui.ts"), "utf8");
  const electronFiles = readdirSync(join(root, "electron"), { recursive: true })
    .filter((name) => typeof name === "string" && name.endsWith(".ts"));
  const dialogMethods = new Set();
  const browserWindowCreations = [];
  let hasAboutPanelCall = false;
  for (const name of electronFiles) {
    const source = readFileSync(join(root, "electron", name), "utf8");
    for (const match of source.matchAll(/\b(?:deps\.)?dialog\.(showMessageBox|showMessageBoxSync|showErrorBox|showOpenDialog|showOpenDialogSync|showSaveDialog|showSaveDialogSync)\s*\(/g)) {
      dialogMethods.add(match[1]);
    }
    for (const match of source.matchAll(/new\s+BrowserWindow\s*\(([^\n]*)/g)) browserWindowCreations.push({ name, call: match[1] });
    if (/\bapp\.showAboutPanel\s*\(/.test(source)) hasAboutPanelCall = true;
  }
  for (const method of dialogMethods) assert.ok(router.includes(`routeDialogMethod(deps.dialog, "${method}"`), `${method} call sites must be routed`);
  assert.deepEqual(browserWindowCreations.map(({ name }) => name).sort(), ["main.ts", "windows.ts"], "new main-process BrowserWindows must use one of the guarded Aya factories");
  assert.ok(browserWindowCreations.some(({ name, call }) => name === "main.ts" && call.includes("headlessWindowOptions(options)")));
  assert.ok(browserWindowCreations.some(({ name, call }) => name === "windows.ts" && call.includes("deps.headlessWindowOptions")));
  assert.match(router, /routeWindowMethod\(deps\.BrowserWindow\.prototype, "show", "window\.show"/);
  assert.match(router, /routeWindowMethod\(deps\.BrowserWindow\.prototype, "showInactive", "window\.showInactive"/);
  assert.match(router, /routeNotificationMethod\(deps\.Notification\.prototype/);
  if (hasAboutPanelCall) assert.match(router, /routeObjectMethod\(deps\.app, "showAboutPanel", "app\.showAboutPanel"/);
  const bootstrap = readFileSync(join(root, "e2e/helpers/headless-main.cjs"), "utf8");
  assert.ok(bootstrap.indexOf("installHeadlessUiRouter(") < bootstrap.indexOf("require(main)"), "headless router must install before wrapper or app main code");
  const e2eFiles = readdirSync(join(root, "e2e"), { recursive: true }).filter((name) => typeof name === "string" && name.endsWith(".ts"));
  const direct = [];
  const electronSpawns = [];
  for (const name of e2eFiles) {
    const text = readFileSync(join(root, "e2e", name), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/\b(?:_electron|electron)\.launch\s*\(/.test(line) && !name.startsWith("fixtures.ts")) direct.push(`${name}:${index + 1}`);
      if (/\bspawn\s*\(\s*(?:electronBinary|(?:require|import)\(['\"]electron['\"]\))/.test(line) && !name.startsWith("fixtures.ts")) electronSpawns.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(direct, [], "all direct Electron launches must go through launchE2eElectron");
  assert.deepEqual(electronSpawns, [], "Electron binary subprocesses must go through spawnE2eElectron");
  const fixtures = readFileSync(join(root, "e2e/fixtures.ts"), "utf8");
  assert.match(fixtures, /export function launchE2eElectron[\s\S]*?args\[0\] = join\(APP_ROOT, "e2e", "helpers", "headless-main\.cjs"\)/);
  assert.match(fixtures, /export function spawnE2eElectron[\s\S]*?args\[0\] = join\(APP_ROOT, "e2e", "helpers", "headless-main\.cjs"\)/);
  const routerSpec = readFileSync(join(root, "e2e/headless-ui-router.spec.ts"), "utf8");
  assert.match(routerSpec, /BrowserWindow\.getAllWindows\(\)\[0\][\s\S]*?window\.show\(\)/, "the probe must call show on Aya's real main window");
  assert.doesNotMatch(readFileSync(join(root, "electron/preload.ts"), "utf8"), /probeVisibleWindow/);
});
