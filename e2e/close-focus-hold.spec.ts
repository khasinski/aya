import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { fireShortcut } from "./helpers/shortcut";
import { visiblePane } from "./helpers/terminal";

// Live finding F5: closing the pane the user was typing in moved keyboard focus
// to a neighbour, so the rest of the message landed in another agent's composer.
// After a close the neighbour may become the selected pane, but keystrokes must
// not reach it until the user picks it (click, sidebar, navigation shortcut).
// Single view is where it leaked; a split leaves an empty active cell and is a guard.

const bufferOf = (window: Page, id: string) =>
  window.evaluate((tid) => window.aya.ptyBuffer(tid), id);

async function readyIds(window: Page) {
  const ids: Record<string, string> = {};
  for (const name of ["shell 1", "shell 2"]) {
    const id = await window
      .locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]`)
      .getAttribute("data-terminal-id");
    expect(id).toBeTruthy();
    ids[name] = id!;
    await expect.poll(() => bufferOf(window, id!).then((b) => b.length)).toBeGreaterThan(0);
  }
  return ids;
}

for (const split of [true, false]) {
  test.describe(split ? "split view" : "single view", () => {
    test.use({ seedOptions: { split } });

    test("keystrokes typed across a close do not reach the neighbour pane", async ({
      window,
      app,
    }) => {
      const ids = await readyIds(window);
      await visiblePane(window, "shell 1").locator(".aya-xterm-host").click();
      await window.keyboard.type("echo head");

      await fireShortcut(app, "close-tab");
      await expect(window.locator('[data-testid="terminal-pane"][data-terminal-name="shell 1"]')).toHaveCount(0);
      await expect(visiblePane(window, "shell 2")).toBeVisible();
      // Past the focus effect's retries, so a late focus cannot hide the leak.
      await window.waitForTimeout(300);
      await window.keyboard.type("zqtailmark");

      // The user picks the pane; typing from then on is theirs to send there.
      await visiblePane(window, "shell 2").locator(".aya-xterm-host").click();
      await window.keyboard.type("zqpickedmark");
      await expect.poll(() => bufferOf(window, ids["shell 2"])).toContain("zqpickedmark");
      expect(await bufferOf(window, ids["shell 2"])).not.toContain("zqtailmark");
    });
  });
}
