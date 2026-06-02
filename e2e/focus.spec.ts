import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Pin down the "focus does not switch / needs two clicks" class of bug: clicking
// a split pane must, in a SINGLE click, make it the active cell AND move
// keyboard focus into its terminal. If the app needs two clicks, this fails.

function paneByTitle(window: Page, title: string) {
  return window.locator(".aya-pane").filter({
    has: window.locator(".aya-pane-header-title", { hasText: new RegExp(`^${title}$`) }),
  });
}

test("clicking a split pane activates it and focuses its terminal in one click", async ({
  window,
}) => {
  const pane1 = paneByTitle(window, "shell 1");
  const pane2 = paneByTitle(window, "shell 2");

  // Seeded initial state: cell 0 (shell 1) is the active split cell.
  await expect(pane1).toHaveClass(/aya-pane--active-split/);
  await expect(pane2).not.toHaveClass(/aya-pane--active-split/);

  // ONE click into the second pane's terminal area.
  await pane2.locator(".aya-xterm-host").click();

  // Active-split must move to pane 2 (and leave pane 1) on that single click.
  await expect(pane2).toHaveClass(/aya-pane--active-split/);
  await expect(pane1).not.toHaveClass(/aya-pane--active-split/);

  // Keyboard focus must now live inside pane 2's terminal, not pane 1.
  await expect
    .poll(() =>
      window.evaluate(() => {
        const panes = Array.from(document.querySelectorAll(".aya-pane"));
        const p2 = panes.find(
          (p) => p.querySelector(".aya-pane-header-title")?.textContent === "shell 2",
        );
        const active = document.activeElement;
        return !!(p2 && active && active !== document.body && p2.contains(active));
      }),
    )
    .toBe(true);
});

test("typing after one click on a pane goes to that pane's terminal", async ({ window }) => {
  // A stronger statement of the same contract: after a single click, the focused
  // element is a text input (xterm's helper textarea), so keystrokes would land
  // in shell 2 rather than being swallowed or routed to shell 1.
  const pane2 = paneByTitle(window, "shell 2");
  await pane2.locator(".aya-xterm-host").click();

  const activeTag = await window.evaluate(
    () => document.activeElement?.tagName.toLowerCase() ?? null,
  );
  expect(activeTag).toBe("textarea");
});
