import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { Page } from "@playwright/test";

// SearchModal result kinds beyond buffer-content matching: running a launcher
// and jumping to a terminal by name. (Only the content-match -> switch flow was
// covered before.)
//
// Single-view seed so the visible terminal IS the active one - asserting the
// real visible pane avoids the sidebar-highlight proxy (which can diverge from
// split-pane focus).
test.use({ seedOptions: { split: false } });

const visiblePane = (window: Page, name: string) =>
  window.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]:visible`);

test("search can run a launcher preset to spawn a terminal for that preset", async ({
  window,
  app,
}) => {
  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(2);

  await fireShortcut(app, "search");
  await window.locator(".aya-search-input").fill("Shell");
  // Target the launcher result by its label ("Run <preset>"), not a row substring.
  await window
    .locator(".aya-search-row")
    .filter({ has: window.locator(".aya-search-label", { hasText: "Run Shell" }) })
    .first()
    .click();

  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(3);
  // The spawned terminal is the "Shell" preset and is now the visible one.
  await expect(visiblePane(window, "Shell")).toBeVisible();
});

test("search jumps to a terminal selected by name", async ({ window, app }) => {
  // Before: shell 1 is the visible/active terminal.
  await expect(visiblePane(window, "shell 1")).toBeVisible();

  await fireShortcut(app, "search");
  await window.locator(".aya-search-input").fill("shell 2");
  await window
    .locator(".aya-search-row")
    .filter({ has: window.locator(".aya-search-label", { hasText: "shell 2" }) })
    .first()
    .click();

  // After: shell 2 is now the visible terminal (real focus change, not a proxy).
  await expect(visiblePane(window, "shell 2")).toBeVisible();
  await expect(visiblePane(window, "shell 1")).toHaveCount(0);
});
