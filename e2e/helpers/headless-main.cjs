// Electron's NODE_OPTIONS preload is not guaranteed to run before a wrapper
// main entry. Use this as the entry for every headless e2e launch so wrapper
// scripts can install intentional dialog fakes only after the router exists.
if (process.env.AYA_E2E_HEADLESS === "1") {
  const { BrowserWindow, dialog, ipcMain } = require("electron");
  const { installHeadlessUiRouter } = require(process.env.AYA_E2E_HEADLESS_UI_MODULE);
  installHeadlessUiRouter({ env: process.env, dialog, BrowserWindow, ipcMain });
}

const main = process.env.AYA_E2E_REAL_MAIN;
if (!main) throw new Error("Headless e2e main entry is missing");
process.argv[1] = main;
require(main);
