import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { installHeadlessUiRouter } = await import("../dist-electron/e2e-headless-ui.js");

test("headless UI routing records and suppresses every native dialog and BrowserWindow show path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "ui.jsonl");
  const native = [];
  const rendererHandlers = new Map();
  const ipcMain = { on: (channel, handler) => { rendererHandlers.set(channel, handler); } };
  class FakeWindow {
    show() { native.push("show"); }
    showInactive() { native.push("showInactive"); }
  }
  const dialog = {
    async showMessageBox() { native.push("showMessageBox"); return { response: 0, checkboxChecked: false }; },
    showErrorBox() { native.push("showErrorBox"); },
    async showOpenDialog() { native.push("showOpenDialog"); return { canceled: false, filePaths: ["/should-not-open"] }; },
  };
  installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: logPath }, dialog, BrowserWindow: FakeWindow, ipcMain });

  const original = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = async (...args) => args.at(-1)?.message === "expected test prompt"
    ? { response: 0, checkboxChecked: false }
    : original(...args);
  assert.deepEqual(await dialog.showMessageBox({ message: "expected test prompt" }), { response: 0, checkboxChecked: false });
  assert.deepEqual(await dialog.showMessageBox({ cancelId: 2 }), { response: 2, checkboxChecked: false });
  dialog.showErrorBox("title", "body");
  assert.deepEqual(await dialog.showOpenDialog({}), { canceled: true, filePaths: [] });
  new FakeWindow().show();
  new FakeWindow().showInactive();
  const event = { returnValue: "unset" };
  rendererHandlers.get("e2e:headless-ui-renderer")(event, "renderer.alert");
  assert.equal(event.returnValue, undefined);
  assert.deepEqual(native, [], "headless routing must never call the native dialog/window APIs");
  assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind), [
    "dialog.showMessageBox", "dialog.showMessageBox", "dialog.showErrorBox", "dialog.showOpenDialog", "window.show", "window.showInactive", "renderer.alert",
  ]);
});

test("headless mode refuses to start its UI router without an event log", () => {
  class FakeWindow { show() {} showInactive() {} }
  const dialog = { showMessageBox() {}, showErrorBox() {}, showOpenDialog() {} };
  assert.throws(() => installHeadlessUiRouter({ env: { AYA_E2E_HEADLESS: "1" }, dialog, BrowserWindow: FakeWindow }), /AYA_E2E_HEADLESS_UI_LOG is required/);
});

test("a router preloaded before main later attaches renderer dialog IPC", () => {
  const dir = mkdtempSync(join(tmpdir(), "aya-headless-ui-preload-"));
  try {
    class FakeWindow { show() {} showInactive() {} }
    const dialog = { showMessageBox() {}, showErrorBox() {}, showOpenDialog() {} };
    const env = { AYA_E2E_HEADLESS: "1", AYA_E2E_HEADLESS_UI_LOG: join(dir, "ui.jsonl") };
    installHeadlessUiRouter({ env, dialog, BrowserWindow: FakeWindow });
    const handlers = new Map();
    installHeadlessUiRouter({ env, dialog, BrowserWindow: FakeWindow, ipcMain: { on: (channel, callback) => { handlers.set(channel, callback); } } });
    const event = { returnValue: "unset" };
    handlers.get("e2e:headless-ui-renderer")(event, "renderer.confirm");
    assert.equal(event.returnValue, false);
    assert.equal(readFileSync(env.AYA_E2E_HEADLESS_UI_LOG, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main installs the router before app windows and all Electron e2e launches use the shared headless gate", () => {
  const main = readFileSync(join(root, "electron/main.ts"), "utf8");
  assert.match(main, /installHeadlessUiRouter\(\{\s*env:\s*process\.env,\s*dialog,\s*BrowserWindow,\s*ipcMain\s*\}\)/);
  assert.ok(main.indexOf("installHeadlessUiRouter(") < main.indexOf("createAyaWindows("), "router must install before creating any Aya window");
  const preload = readFileSync(join(root, "electron/preload.ts"), "utf8");
  assert.match(preload, /executeInMainWorld[\s\S]*window\.alert[\s\S]*renderer\.alert/);
  const bootstrap = readFileSync(join(root, "e2e/helpers/headless-main.cjs"), "utf8");
  assert.ok(bootstrap.indexOf("installHeadlessUiRouter(") < bootstrap.indexOf("require(main)"), "headless router must install before wrapper or app main code");
  const e2eFiles = readdirSync(join(root, "e2e"), { recursive: true }).filter((name) => typeof name === "string" && name.endsWith(".ts"));
  const direct = [];
  for (const name of e2eFiles) {
    const text = readFileSync(join(root, "e2e", name), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/\b(?:_electron|electron)\.launch\s*\(/.test(line) && !name.startsWith("fixtures.ts")) direct.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(direct, [], "all direct Electron launches must go through launchE2eElectron");
  const fixtures = readFileSync(join(root, "e2e/fixtures.ts"), "utf8");
  assert.match(fixtures, /export function launchE2eElectron[\s\S]*?args\[0\] = join\(APP_ROOT, "e2e", "helpers", "headless-main\.cjs"\)/);
});
