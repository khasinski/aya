import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { ElectronApplication, Page } from "@playwright/test";

// Split panes are disabled in the experimental "Projects on left" layout. The
// seeded project ships a 1x2 split (two panes); in this layout only the active
// terminal should render, and the terminal context menu must offer no split
// actions.

async function enableProjectsLeftLayout(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings
    .locator('.aya-settings-segmented[aria-label="Window layout"] button', { hasText: "Projects on left" })
    .click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
}

test("only one terminal is visible (no split) in Projects-on-left", async ({ window, app }) => {
  // Hidden terminals stay mounted (display:none) as a persistence pool, so we
  // count only VISIBLE panes. The classic layout shows both seeded split panes...
  await expect(window.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(2);

  await enableProjectsLeftLayout(window, app);

  // ...but the experimental layout collapses to a single visible terminal.
  await expect(window.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(1);
  // Both terminals still exist as top tabs - only the split view is gone.
  await expect(window.getByTestId("termtab")).toHaveCount(2);
});

test("the terminal context menu offers no split actions in Projects-on-left", async ({ window, app }) => {
  await enableProjectsLeftLayout(window, app);

  await window.getByTestId("termtab").first().click({ button: "right" });
  const menu = window.locator(".aya-context-menu");
  await expect(menu).toBeVisible();

  await expect(menu).toContainText("Rename terminal");
  await expect(menu).toContainText("Restart terminal");
  await expect(menu).toContainText("Close terminal");
  // No split-related entries.
  await expect(menu).not.toContainText("Split right");
  await expect(menu).not.toContainText("Split below");
  await expect(menu).not.toContainText("Show in active pane");
  await expect(menu).not.toContainText("Remove from split");
});
