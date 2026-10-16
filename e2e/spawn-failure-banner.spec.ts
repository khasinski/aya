import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Spawn-failure recovery banner. An empty preset command makes the PTY preflight
// report preset-empty-command and render the banner. Single-view seed so there
// is exactly one visible pane/banner (no split-pane .first() ambiguity).

test.use({
  seedOptions: {
    split: false,
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "   " }],
  },
});

const visibleBanner = (window: Page) => window.locator(".aya-pane-recovery:visible");

test("the recovery banner shows for an empty-command preset", async ({ window }) => {
  const banner = visibleBanner(window);
  await expect(banner).toBeVisible();
  await expect(banner.locator(".aya-pane-recovery-text strong")).toHaveText("Preset command is empty");
  await expect(banner.locator(".aya-pane-recovery-btn", { hasText: "Open Settings" })).toBeVisible();
});

// The banner's primary "Restart" must actually re-attempt the spawn. The preset
// command is still empty, so a real retry fails again and the banner stays. If
// Restart only clears spawnFailure without re-spawning, the banner vanishes and
// the terminal is left "running" with no PTY (a zombie) - this asserts it does NOT.
test("the banner Restart re-attempts the spawn instead of leaving a zombie terminal", async ({
  window,
}) => {
  const banner = visibleBanner(window);
  await expect(banner).toBeVisible();

  // Each spawn attempt echoes "[process exited with code 127]" into the
  // terminal (pty.ts reportSpawnFailure). The initial failure produced one.
  // A no-op clear-only Restart (the old zombie bug) leaves the banner visible
  // too, so asserting visibility alone would false-pass. A REAL respawn fails
  // again and writes a SECOND exit echo - count must reach 2.
  const exitEchoes = () =>
    window
      .locator(".aya-xterm-host:visible")
      .first()
      .innerText()
      .then((t) => (t.match(/process exited with code/g) || []).length);
  await expect.poll(exitEchoes).toBe(1);

  await banner.locator(".aya-pane-recovery-btn--primary", { hasText: "Restart" }).click();

  // Restart actually re-attempted the spawn (not a clear-only no-op).
  await expect.poll(exitEchoes).toBe(2);

  // Still broken (empty command) -> the failure banner must still be shown.
  await expect(visibleBanner(window)).toBeVisible();
  await expect(
    visibleBanner(window).locator(".aya-pane-recovery-text strong"),
  ).toHaveText("Preset command is empty");
});

test("the pane-limit card Restart clears the failure and requests that pane again", async ({ app, window }) => {
  const banner = visibleBanner(window);
  await expect(banner).toBeVisible();
  const paneId = await window.locator('[data-testid="terminal-pane"]:visible').first().getAttribute("data-terminal-id");
  expect(paneId).toBeTruthy();

  await app.evaluate(({ BrowserWindow, ipcMain }, id) => {
    const g = globalThis as unknown as { paneLimitRetryRequests: Array<{ ptyId: string }> };
    g.paneLimitRetryRequests = [];
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("seeded app window is missing");

    // Deliver the same typed host event the real owner-backed cap path emits,
    // then record the renderer's explicit Retry without starting another PTY.
    win.webContents.send("pty:event", {
      type: "spawn-failed",
      ptyId: id,
      reason: "pane-limit-reached",
      detail: "Aya can run at most 128 terminals at once. Close a terminal you no longer need, then restart this tab.",
    });
    ipcMain.removeHandler("pty:spawn");
    ipcMain.handle("pty:spawn", (_event, request) => {
      g.paneLimitRetryRequests.push(request);
      return true;
    });
  }, paneId!);

  await expect(banner.locator(".aya-pane-recovery-text p")).toHaveText(
    "Aya can run at most 128 terminals at once. Close a terminal you no longer need, then restart this tab.",
  );
  await banner.locator(".aya-pane-recovery-btn--primary", { hasText: "Restart" }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { paneLimitRetryRequests: unknown[] }).paneLimitRetryRequests)).toHaveLength(1);
  const requests = await app.evaluate(() => (globalThis as unknown as { paneLimitRetryRequests: Array<{ ptyId: string }> }).paneLimitRetryRequests);
  expect(requests[0].ptyId).toBe(paneId);
  await expect(visibleBanner(window)).toHaveCount(0);
});
