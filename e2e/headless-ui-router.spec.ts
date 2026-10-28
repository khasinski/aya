import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, expectHeadlessUiEvents } from "./fixtures";

test("headless Electron records and cancels native and renderer dialogs and window show requests", async ({ app, window, seeded }) => {
  const expectedUnhandled = [
    "dialog.showMessageBox", "dialog.showErrorBox", "dialog.showOpenDialog", "window.show", "window.showInactive", "renderer.alert", "renderer.confirm",
  ];
  const expectedRecorded = [...expectedUnhandled, "renderer.confirm"];
  expectHeadlessUiEvents(seeded, expectedUnhandled);
  await expect(window.locator("body")).toBeVisible();
  const pageDialogs: string[] = [];
  window.on("dialog", (dialog) => { pageDialogs.push(dialog.type()); void dialog.dismiss(); });
  await window.evaluate(() => {
    (window as Window & { headlessDialogEvents?: unknown[] }).headlessDialogEvents = [];
    window.addEventListener("aya:e2e-headless-dialog", (event) => {
      (window as Window & { headlessDialogEvents: unknown[] }).headlessDialogEvents.push((event as CustomEvent).detail);
    });
  });
  const result = await app.evaluate(async ({ BrowserWindow, dialog }) => {
    const message = await dialog.showMessageBox({ message: "headless router probe", cancelId: 1, defaultId: 0 });
    dialog.showErrorBox("headless router probe", "must not show");
    const open = await dialog.showOpenDialog({ properties: ["openFile"] });
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.showInactive();
    await window.webContents.executeJavaScript("window.alert('headless renderer probe')");
    const cancelled = await window.webContents.executeJavaScript("window.confirm('default cancel')");
    await window.webContents.executeJavaScript("window.__ayaE2eHeadlessUi.setResponse('renderer.confirm', true)");
    const accepted = await window.webContents.executeJavaScript("window.confirm('test accepted')");
    return { message, open, visible: BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible()), cancelled, accepted };
  });
  expect(result.message.response).toBe(1);
  expect(result.open).toEqual({ canceled: true, filePaths: [] });
  expect(result.visible).toBe(false);
  await expect.poll(() => window.evaluate(() => (window as Window & { headlessDialogEvents: Array<{ kind: string; message: string }> }).headlessDialogEvents)).toEqual([
    { kind: "renderer.alert", message: "headless renderer probe" },
    { kind: "renderer.confirm", message: "default cancel" },
    { kind: "renderer.confirm", message: "test accepted" },
  ]);
  expect(result.cancelled).toBe(false);
  expect(result.accepted).toBe(true);
  expect(pageDialogs).toEqual([]);
  const lines = readFileSync(join(seeded.root, "e2e-headless-ui.log"), "utf8").trim().split("\n");
  expect(lines.map((line) => JSON.parse(line).kind)).toEqual(expectedRecorded);
});
