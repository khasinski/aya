// Electron's NODE_OPTIONS preload is not guaranteed to run before a wrapper
// main entry. Use this as the entry for every headless e2e launch so wrapper
// scripts can install intentional dialog fakes only after the router exists.
if (process.env.AYA_E2E_HEADLESS === "1") {
  const electron = require("electron");
  if (!process.env.AYA_E2E_HEADLESS_UI_MODULE) throw new Error("Headless e2e UI router module is missing");
  const { installHeadlessUiRouter } = require(process.env.AYA_E2E_HEADLESS_UI_MODULE);
  installHeadlessUiRouter({
    env: process.env,
    app: electron.app,
    dialog: electron.dialog,
    BrowserWindow: electron.BrowserWindow,
    Notification: electron.Notification,
    ipcMain: electron.ipcMain,
  });
}

const main = process.env.AYA_E2E_REAL_MAIN;
if (!main) throw new Error("Headless e2e main entry is missing");
process.argv[1] = main;
require(main);
