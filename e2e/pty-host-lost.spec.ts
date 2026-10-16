import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, hostPidsForHome, test as base, launchApp, closeAndWait } from "./fixtures";
import { waitForShellReady } from "./helpers/terminal";

// These are the unknown-key reuse cases. A main that created the host now
// recovers it automatically; an ordinary app relaunch has no owner credential.
const test=base.extend({app:async({seeded},use)=>{
  const env={...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:"0"}};
  const first=await launchApp(env);
  await waitForShellReady(await first.firstWindow());
  await expect.poll(()=>inventory(seeded.ayaHome).panes.length).toBe(2);
  await closeAndWait(first);
  const reused=await launchApp(env);await use(reused);await closeAndWait(reused);
}});

type Inventory = { pid: number; panes: Array<{ id: string; pid: number; generation: number }> };
const inventory = (home: string): Inventory => JSON.parse(readFileSync(join(home, "pty-owner/record.json"), "utf8"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const panes = (record: Inventory) => record.panes.map(({ id, pid, generation }) => ({ id, pid, generation })).sort((a, b) => a.id.localeCompare(b.id));

async function loseHost(window: Page, home: string) {
  await waitForShellReady(window);
  await expect.poll(() => inventory(home).panes.length).toBe(2);
  const before = inventory(home), hosts = hostPidsForHome(home);
  expect(hosts).toHaveLength(1);
  for (const pid of hosts) process.kill(pid, "SIGKILL");
  await expect.poll(() => hosts.some(alive)).toBe(false);
  const row = window.locator('.aya-sidebar-row[data-terminal-name="shell 1"]');
  await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
  await expect(window.getByTestId("xterm-host").first()).toContainText("terminal host disconnected");
  await expect(window.getByTestId("terminal-history-notice").first()).toContainText("Aya restarted since this terminal host started");
  return { before, row };
}

test("a killed JS host leaves its shells alive and disconnected; Shift+Enter never silently respawns them", async ({ app, window, seeded }) => {
  const { before, row } = await loseHost(window, seeded.ayaHome);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { unexpectedSpawns: unknown[] }; g.unexpectedSpawns = [];
    ipcMain.removeHandler("pty:spawn");
    ipcMain.handle("pty:spawn", (_event, req) => { g.unexpectedSpawns.push(req); });
  });
  await window.getByTestId("xterm-host").first().click();
  await window.keyboard.press("Shift+Enter");
  await window.waitForTimeout(500);
  await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
  expect(await app.evaluate(() => (globalThis as unknown as { unexpectedSpawns: unknown[] }).unexpectedSpawns)).toEqual([]);
  expect(alive(before.pid)).toBe(true);
  for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
  const after = inventory(seeded.ayaHome);
  expect(after.pid).toBe(before.pid); expect(panes(after)).toEqual(panes(before));
});

test("a refused kill explains why restart stopped and keeps the disconnected pane without another spawn", async ({ app, window, seeded }) => {
  const { before, row } = await loseHost(window, seeded.ayaHome);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { unexpectedSpawns: unknown[]; restartQuestions: number };
    g.unexpectedSpawns = []; g.restartQuestions = 0;
    ipcMain.removeHandler("pty:confirm-restart");
    ipcMain.handle("pty:confirm-restart", () => { g.restartQuestions++; return true; });
    ipcMain.removeHandler("pty:kill");
    ipcMain.handle("pty:kill", () => { throw new Error("The native owner cannot authenticate this Aya"); });
    ipcMain.removeHandler("pty:spawn");
    ipcMain.handle("pty:spawn", (_event, req) => { g.unexpectedSpawns.push(req); });
  });
  const told = new Promise<string>(resolve => window.once("dialog", dialog => { resolve(dialog.message()); void dialog.accept(); }));
  await row.click({ button: "right" });
  await window.locator(".aya-context-menu-item", { hasText: "Restart terminal" }).click();
  const message = await told;
  expect(message).toContain("Aya did not restart shell 1: it could not confirm that the old terminal stopped");
  expect(message).toContain("The native owner cannot authenticate this Aya");
  await window.waitForTimeout(500);
  await expect(row).toBeVisible();
  await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
  await expect(window.getByTestId("xterm-host").first()).toContainText("terminal host disconnected");
  expect(await app.evaluate(() => {
    const g = globalThis as unknown as { unexpectedSpawns: unknown[]; restartQuestions: number };
    return { questions: g.restartQuestions, spawns: g.unexpectedSpawns };
  })).toEqual({ questions: 1, spawns: [] });
  expect(alive(before.pid)).toBe(true);
  for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
  const after = inventory(seeded.ayaHome);
  expect(after.pid).toBe(before.pid); expect(panes(after)).toEqual(panes(before));
});

test("typing and paste into a disconnected pane are disabled instead of silently sending input", async ({ app, window, seeded }) => {
  const { before } = await loseHost(window, seeded.ayaHome);
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { disconnectedWrites: unknown[] }; g.disconnectedWrites = [];
    ipcMain.removeHandler("pty:write");
    ipcMain.handle("pty:write", (_event, ...args) => { g.disconnectedWrites.push(args); return false; });
  });
  const terminal = window.getByTestId("xterm-host").first(); await terminal.click();
  await window.keyboard.type("must not be sent"); await window.keyboard.press("Enter"); await window.keyboard.press("Control+c");
  await terminal.locator(".xterm-helper-textarea").evaluate(textarea => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "pasted text\n");
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await terminal.click({ button: "right" });
  await expect(window.getByTestId("terminal-context-paste")).toBeDisabled();
  await window.keyboard.press("Escape");
  await expect(terminal).toContainText("Input is disabled while disconnected");
  expect(await app.evaluate(() => (globalThis as unknown as { disconnectedWrites: unknown[] }).disconnectedWrites)).toEqual([]);
  expect(alive(before.pid)).toBe(true); for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
});

test.describe("a pane mounted after its host disconnected", () => {
  test.use({ seedOptions: { split: false } });
  test("shows the disconnected explanation from stored state and keeps input disabled", async ({ app, window, seeded }) => {
    await waitForShellReady(window);
    const projectFile = join(seeded.ayaHome, "projects/e2e-proj.json");
    const project = JSON.parse(readFileSync(projectFile, "utf8"));
    project.tabs.push({ id: "deferred", presetId: "shell", name: "Deferred" });
    writeFileSync(projectFile, JSON.stringify(project));
    const row = window.locator('.aya-sidebar-row[data-terminal-name="Deferred"]');
    await expect(row).toBeVisible();
    await expect(window.locator('.aya-pane[data-terminal-id="deferred"]')).toHaveCount(0);
    await window.evaluate(cwd => window.aya.ptySpawn({ ptyId: "deferred", command: "/bin/sleep 60", cwd, cols: 80, rows: 24 }), seeded.projectDir);
    await expect.poll(() => inventory(seeded.ayaHome).panes.length).toBe(3);
    const before = inventory(seeded.ayaHome), hosts = hostPidsForHome(seeded.ayaHome);
    expect(hosts).toHaveLength(1); process.kill(hosts[0], "SIGKILL");
    await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
    await expect(window.locator('.aya-pane[data-terminal-id="deferred"]')).toHaveCount(0);
    // Suppress all attach/replay responses: the warning must come from stored
    // disconnected state on the first mount, rather than a new PTY event.
    await app.evaluate(({ ipcMain }) => {
      (globalThis as unknown as { deferredWrites: unknown[] }).deferredWrites = [];
      ipcMain.removeHandler("pty:spawn"); ipcMain.handle("pty:spawn", () => {});
      ipcMain.removeHandler("pty:write");
      ipcMain.handle("pty:write", (_event, ...args) => { (globalThis as unknown as { deferredWrites: unknown[] }).deferredWrites.push(args); return false; });
    });
    await row.click();
    const terminal = window.locator('.aya-pane[data-terminal-id="deferred"]').getByTestId("xterm-host");
    await expect(terminal).toContainText("terminal host disconnected");
    await expect(terminal).toContainText("Input is disabled while disconnected");
    await expect(row.locator(".aya-sidebar-statusdot")).toHaveClass(/--error/);
    await terminal.click(); await window.keyboard.type("not delivered"); await window.keyboard.press("Enter");
    await terminal.locator(".xterm-helper-textarea").evaluate(textarea => {
      const transfer = new DataTransfer(); transfer.setData("text/plain", "late pasted input\n");
      textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    });
    expect(await app.evaluate(() => (globalThis as unknown as { deferredWrites: unknown[] }).deferredWrites)).toEqual([]);
    expect(alive(before.pid)).toBe(true); for (const pane of before.panes) expect(alive(pane.pid)).toBe(true);
  });
});
