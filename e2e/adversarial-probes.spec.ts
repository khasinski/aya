import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { Page } from "@playwright/test";

// Adversarial probes - they assert the CORRECT expected behaviour in tricky
// states. A failure here is a hidden-bug candidate, not a test to paper over.

const visiblePanes = (window: Page) => window.locator('[data-testid="terminal-pane"]:visible');
const visiblePane = (window: Page, name: string) =>
  window.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]:visible`);

// P1 - "Split below" should behave like "Split right": a second cell appears and
// can be filled. Only "Split right" was exercised.
test.describe("no split seed", () => {
  test.use({ seedOptions: { split: false } });

  test("P1 Split below creates a fillable second cell", async ({ window }) => {
    await expect(visiblePanes(window)).toHaveCount(1);
    await window
      .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]')
      .click({ button: "right" });
    await window.locator(".aya-context-menu .aya-context-menu-item", { hasText: "Split below" }).click();
    await expect(window.locator(".aya-pane-empty")).toBeVisible();
    await window
      .locator(".aya-pane-empty .aya-pane-empty-terminal")
      .filter({ has: window.getByText("shell 2", { exact: true }) })
      .click();
    await expect(visiblePane(window, "shell 1")).toBeVisible();
    await expect(visiblePane(window, "shell 2")).toBeVisible();
  });

  test("P4 renaming a terminal to whitespace keeps the original name", async ({ window }) => {
    // Stable row reference by attribute - filtering by text breaks once the
    // inline editor replaces the name text.
    const row = window.locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]');
    const input = row.locator(".aya-sidebar-rename");
    // Robustly open the inline editor (cold-start can swallow the first dblclick).
    await expect(async () => {
      await row.locator(".aya-sidebar-name").dblclick();
      await input.fill("   ", { timeout: 800 });
      await input.press("Enter", { timeout: 800 });
    }).toPass({ timeout: 15000 });
    // blank rename must be rejected - the name stays "shell 1"
    await expect(
      window.locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]'),
    ).toHaveCount(1);
  });

  test("P6 next-tab cycles and wraps back to the first terminal", async ({ window, app }) => {
    await expect(visiblePane(window, "shell 1")).toBeVisible();
    await fireShortcut(app, "next-tab");
    await expect(visiblePane(window, "shell 2")).toBeVisible();
    await fireShortcut(app, "next-tab"); // wrap
    await expect(visiblePane(window, "shell 1")).toBeVisible();
  });
});

// P2 - closing the active pane's terminal in a split must keep the other one.
test("P2 closing the active terminal in a split keeps the other visible", async ({ window }) => {
  await expect(visiblePanes(window)).toHaveCount(2); // seeded 1x2
  await window
    .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]')
    .click({ button: "right" });
  await window.locator(".aya-context-menu .aya-context-menu-item", { hasText: "Close terminal" }).click();
  await expect(visiblePane(window, "shell 2")).toBeVisible();
  await expect(visiblePane(window, "shell 1")).toHaveCount(0);
});

// P5 - launching a terminal while split shows the new terminal in the active cell.
test("P5 launching in a split shows the new terminal in the active cell", async ({ window }) => {
  await expect(visiblePanes(window)).toHaveCount(2);
  // active cell is cell 0 (shell 1). Launch a new Shell.
  await window.locator(".aya-launcher .aya-launcher-btn", { hasText: "Shell" }).click();
  // new "Shell" terminal takes the active cell; shell 2 still in the other cell.
  await expect(visiblePane(window, "Shell")).toBeVisible();
  await expect(visiblePane(window, "shell 2")).toBeVisible();
  await expect(visiblePane(window, "shell 1")).toHaveCount(0);
});

// P7 - in a split, jumping to a visible cell's terminal must make THAT cell the
// active one (the sidebar-highlight vs active-cell divergence reviewers flagged).
test("P7 search-jump in a split activates the target's pane", async ({ window, app }) => {
  await expect(visiblePanes(window)).toHaveCount(2);
  // Before: shell 1 (cell 0) is the active pane - proves the jump CHANGES it.
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 1"]'),
  ).toBeVisible();
  await fireShortcut(app, "search");
  await window.locator(".aya-search-input").fill("shell 2");
  await window
    .locator(".aya-search-row")
    .filter({ has: window.locator(".aya-search-label", { hasText: /^shell 2$/ }) })
    .click();
  // the active-split pane should now be shell 2, not still shell 1
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 2"]'),
  ).toBeVisible();
  // ...and real keyboard focus actually lands inside shell 2's pane (not just
  // the active-split class - the whole point of the bug was focus diverging).
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          document.activeElement
            ?.closest('[data-testid="terminal-pane"]')
            ?.getAttribute("data-terminal-name") ?? null,
      ),
    )
    .toBe("shell 2");
});

// P8 - closing a NON-active terminal in a split must leave the active one intact.
test("P8 closing a non-active split terminal keeps the active one", async ({ window }) => {
  await expect(visiblePanes(window)).toHaveCount(2);
  await window
    .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 2"]')
    .click({ button: "right" });
  await window.locator(".aya-context-menu .aya-context-menu-item", { hasText: "Close terminal" }).click();
  await expect(visiblePane(window, "shell 1")).toBeVisible();
  await expect(visiblePane(window, "shell 2")).toHaveCount(0);
});

// P3 - a terminal displaced out of the split should still be reachable from the
// sidebar (jump shows it).
test("P3 a terminal displaced from the split is shown when selected", async ({ window }) => {
  // Launch a new Shell into the active cell, displacing shell 1 (now hidden).
  await window.locator(".aya-launcher .aya-launcher-btn", { hasText: "Shell" }).click();
  await expect(visiblePane(window, "shell 1")).toHaveCount(0);
  // Selecting shell 1 from the sidebar must bring it back into view.
  await window
    .locator('[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]')
    .click();
  await expect(visiblePane(window, "shell 1")).toBeVisible();
});
