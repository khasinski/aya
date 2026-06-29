import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Creating and tearing down split panes in the classic layout - the split
// actions (sidebar context menu) and empty-cell fill. Only the RENDERING of a
// pre-seeded split was covered before; the actions that build one were not.

const visiblePanes = (window: Page) => window.locator('[data-testid="terminal-pane"]:visible');
const visiblePane = (window: Page, name: string) =>
  window.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]:visible`);

// Single-view seed: two terminals, only the active one visible, no split yet.
test.use({ seedOptions: { split: false } });

test("the sidebar context menu splits a terminal and the empty cell can be filled", async ({
  window,
}) => {
  await expect(visiblePanes(window)).toHaveCount(1);
  await expect(visiblePane(window, "shell 1")).toBeVisible();

  // Split the active terminal (shell 1) to the right - target by attribute, not order.
  await window
    .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]')
    .click({ button: "right" });
  const menu = window.locator(".aya-context-menu");
  await expect(menu).toBeVisible();
  await menu.locator(".aya-context-menu-item", { hasText: "Split right" }).click();

  // A second cell appears, empty, with the hidden terminal offered to fill it.
  const emptyPane = window.locator(".aya-pane-empty");
  await expect(emptyPane).toBeVisible();
  await emptyPane
    .locator(".aya-pane-empty-terminal")
    .filter({ has: window.getByText("shell 2", { exact: true }) })
    .click();

  // Both specific terminals are now visible side by side (identity, not count).
  await expect(visiblePanes(window)).toHaveCount(2);
  await expect(visiblePane(window, "shell 1")).toBeVisible();
  await expect(visiblePane(window, "shell 2")).toBeVisible();
});

test("removing a terminal from the split leaves the other one visible", async ({ window }) => {
  // Build a 2-pane split first.
  await window
    .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]')
    .click({ button: "right" });
  await window.locator(".aya-context-menu .aya-context-menu-item", { hasText: "Split right" }).click();
  await window
    .locator(".aya-pane-empty .aya-pane-empty-terminal")
    .filter({ has: window.getByText("shell 2", { exact: true }) })
    .click();
  await expect(visiblePanes(window)).toHaveCount(2);

  // Remove shell 2 from the split via its sidebar context menu.
  await window
    .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 2"]')
    .click({ button: "right" });
  await window
    .locator(".aya-context-menu .aya-context-menu-item", { hasText: "Remove from split" })
    .click();

  // shell 1 survives as the sole visible pane; shell 2 is gone from the grid.
  await expect(visiblePanes(window)).toHaveCount(1);
  await expect(visiblePane(window, "shell 1")).toBeVisible();
  await expect(visiblePane(window, "shell 2")).toHaveCount(0);
});
