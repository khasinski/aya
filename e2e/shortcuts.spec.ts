import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { Page } from "@playwright/test";

// Keyboard-shortcut actions (electron/main.ts -> "shortcut" IPC -> useAppShortcuts).
// fireShortcut sends the IPC the way the menu/accelerator ultimately does.

const visiblePane = (w: Page, name: string) =>
  w.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]:visible`);
const sidebar = (w: Page, name: string) =>
  w.locator(`[data-testid="sidebar-terminal"][data-terminal-name="${name}"]`);
const activeSplitPane = (w: Page, name: string) =>
  w.locator(`.aya-pane--active-split[data-terminal-name="${name}"]`);
const focusedTerminalName = (w: Page) =>
  w.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-testid="terminal-pane"]')
        ?.getAttribute("data-terminal-name") ?? null,
  );

test.describe("single view (no split)", () => {
  test.use({ seedOptions: { split: false } });

  test("next-tab / prev-tab cycle the visible terminal and wrap around", async ({
    window,
    app,
  }) => {
    await expect(visiblePane(window, "shell 1")).toBeVisible();

    await fireShortcut(app, "next-tab");
    await expect(visiblePane(window, "shell 2")).toBeVisible();
    await expect(visiblePane(window, "shell 1")).toHaveCount(0);

    // Wrap forward: shell 2 -> shell 1.
    await fireShortcut(app, "next-tab");
    await expect(visiblePane(window, "shell 1")).toBeVisible();

    // Wrap backward: shell 1 -> shell 2.
    await fireShortcut(app, "prev-tab");
    await expect(visiblePane(window, "shell 2")).toBeVisible();
  });

  test("close-tab closes the active terminal and repoints to the survivor", async ({
    window,
    app,
  }) => {
    await expect(visiblePane(window, "shell 1")).toBeVisible();
    await expect(sidebar(window, "shell 1")).toBeVisible();

    await fireShortcut(app, "close-tab");

    // shell 1 (the active tab) is gone; the surviving tab becomes active+visible.
    await expect(sidebar(window, "shell 1")).toHaveCount(0);
    await expect(visiblePane(window, "shell 2")).toBeVisible();
  });

  test("project-N out of range is a no-op (no crash, active project unchanged)", async ({
    window,
    app,
  }) => {
    await expect(visiblePane(window, "shell 1")).toBeVisible();
    // Only one open project; index far past the end must not throw or blank out.
    await fireShortcut(app, "project-99");
    await fireShortcut(app, "project-0");
    await expect(visiblePane(window, "shell 1")).toBeVisible();
    // project-1 selects the (only) open project - still showing its terminal.
    await fireShortcut(app, "project-1");
    await expect(visiblePane(window, "shell 1")).toBeVisible();
  });
});

test.describe("split view", () => {
  test.use({ seedOptions: { split: true } });

  // Adversarial: in a split, next-tab should move the ACTIVE PANE (and keyboard
  // focus) to the next terminal - same active-tab-vs-active-cell divergence that
  // was BUG-1 for search/attention/notification jumps. cycleActiveProjectTab
  // sets only activeTabByProject, not the split's active cell, so this asserts
  // the focus actually follows. Failure = the shortcut is dead in a split.
  test("next-tab in a split moves the active pane + focus to the next terminal", async ({
    window,
    app,
  }) => {
    await expect(window.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(2);
    await expect(activeSplitPane(window, "shell 1")).toBeVisible();

    await fireShortcut(app, "next-tab");

    await expect(activeSplitPane(window, "shell 2")).toBeVisible();
    await expect.poll(() => focusedTerminalName(window)).toBe("shell 2");
  });
});
