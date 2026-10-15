import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, hostPidsForHome, test } from "./fixtures";
import { waitForShellReady } from "./helpers/terminal";

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
