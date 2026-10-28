import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, expectHeadlessUiEvents } from "./fixtures";
import { appEnv } from "./helpers/seed";

test("headless Electron records and cancels native UI requests without showing them", async ({ app, window, seeded }) => {
  test.skip(appEnv(seeded).AYA_E2E_HEADLESS !== "1", "router probe is only meaningful in headless mode; CI uses Xvfb");
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() || "(untitled window)");
  const expectedUnhandled = [
    { kind: "dialog.showMessageBox", detail: "headless router probe" },
    { kind: "dialog.showMessageBoxSync", detail: "sync probe" },
    { kind: "dialog.showErrorBox", detail: "headless router probe: must not show" },
    { kind: "dialog.showOpenDialog", detail: "(no message)" },
    { kind: "dialog.showOpenDialogSync", detail: "(no message)" },
    { kind: "dialog.showSaveDialog", detail: "(no message)" },
    { kind: "dialog.showSaveDialogSync", detail: "(no message)" },
    { kind: "window.show", detail: title }, { kind: "window.showInactive", detail: title },
    { kind: "app.showAboutPanel", detail: "About panel" }, { kind: "notification.show", detail: "headless: must not show" },
    { kind: "renderer.alert", detail: "headless renderer probe" }, { kind: "renderer.confirm", detail: "default cancel" },
  ];
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
  const result = await app.evaluate(async ({ BrowserWindow, dialog, app, Notification }) => {
    const message = await dialog.showMessageBox({ message: "headless router probe", cancelId: 1, defaultId: 0 });
    const syncMessage = dialog.showMessageBoxSync({ message: "sync probe", cancelId: 2, defaultId: 0 });
    dialog.showErrorBox("headless router probe", "must not show");
    const open = await dialog.showOpenDialog({ properties: ["openFile"] });
    const openSync = dialog.showOpenDialogSync({ properties: ["openFile"] });
    const save = await dialog.showSaveDialog({});
    const saveSync = dialog.showSaveDialogSync({});
    const window = BrowserWindow.getAllWindows()[0];
    // Exercise show() on Aya's real main window created by createAyaWindows.
    window.show();
    window.showInactive();
    app.showAboutPanel();
    new Notification({ title: "headless", body: "must not show" }).show();
    await window.webContents.executeJavaScript("window.alert('headless renderer probe')");
    const cancelled = await window.webContents.executeJavaScript("window.confirm('default cancel')");
    await window.webContents.executeJavaScript("window.__ayaE2eHeadlessUi.setResponse('renderer.confirm', { message: 'test accepted' }, true)");
    const accepted = await window.webContents.executeJavaScript("window.confirm('test accepted')");
    await window.webContents.executeJavaScript("window.__ayaE2eHeadlessUi.setResponse('renderer.prompt', { message: 'headless prompt' }, 'safe answer')");
    const prompt = await window.webContents.executeJavaScript("window.prompt('headless prompt')");
    return { message, syncMessage, open, openSync, save, saveSync, visible: BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible()), cancelled, accepted, prompt };
  });
  expect(result.message.response).toBe(1);
  expect(result.syncMessage).toBe(2);
  expect(result.open).toEqual({ canceled: true, filePaths: [] });
  expect(result.openSync).toBeUndefined();
  expect(result.save).toEqual({ canceled: true });
  expect(result.saveSync).toBeUndefined();
  expect(result.visible).toBe(false);
  await expect.poll(() => window.evaluate(() => (window as Window & { headlessDialogEvents: Array<{ kind: string; message: string }> }).headlessDialogEvents)).toEqual([
    { kind: "renderer.alert", message: "headless renderer probe" },
    { kind: "renderer.confirm", message: "default cancel" },
    { kind: "renderer.confirm", message: "test accepted" },
    { kind: "renderer.prompt", message: "headless prompt" },
  ]);
  expect(result.cancelled).toBe(false);
  expect(result.accepted).toBe(true);
  expect(result.prompt).toBe("safe answer");
  expect(pageDialogs).toEqual([]);
  const lines = readFileSync(join(seeded.root, "e2e-headless-ui.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(lines.map(({ kind, detail }) => ({ kind, detail }))).toEqual([
    ...expectedUnhandled,
    { kind: "renderer.confirm", detail: "test accepted" },
    { kind: "renderer.prompt", detail: "headless prompt" },
  ]);
});
