import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { Page } from "@playwright/test";

// Directional split-pane focus (focus-pane-left/right/up/down shortcut ->
// focusSplitPane). Moving must shift BOTH the active-cell marker and real
// keyboard focus; moving past an edge must be a no-op.

const activeSplitPane = (w: Page, name: string) =>
  w.locator(`.aya-pane--active-split[data-terminal-name="${name}"]`);
const focusedTerminalName = (w: Page) =>
  w.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-testid="terminal-pane"]')
        ?.getAttribute("data-terminal-name") ?? null,
  );

test.use({ seedOptions: { split: true } }); // 1x2: shell 1 (cell 0), shell 2 (cell 1)

test("focus-pane-right / -left move the active pane and keyboard focus", async ({
  window,
  app,
}) => {
  await expect(window.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(2);
  await expect(activeSplitPane(window, "shell 1")).toBeVisible();

  await fireShortcut(app, "focus-pane-right");
  await expect(activeSplitPane(window, "shell 2")).toBeVisible();
  await expect.poll(() => focusedTerminalName(window)).toBe("shell 2");

  await fireShortcut(app, "focus-pane-left");
  await expect(activeSplitPane(window, "shell 1")).toBeVisible();
  await expect.poll(() => focusedTerminalName(window)).toBe("shell 1");
});

test("focus-pane past an edge is a no-op (active pane unchanged)", async ({
  window,
  app,
}) => {
  await expect(activeSplitPane(window, "shell 1")).toBeVisible();

  // Move to the rightmost pane, then try to go further right -> no-op.
  await fireShortcut(app, "focus-pane-right");
  await expect(activeSplitPane(window, "shell 2")).toBeVisible();
  await fireShortcut(app, "focus-pane-right");
  await expect(activeSplitPane(window, "shell 2")).toBeVisible();

  // Up / down in a single-row layout are also no-ops.
  await fireShortcut(app, "focus-pane-up");
  await expect(activeSplitPane(window, "shell 2")).toBeVisible();
  await fireShortcut(app, "focus-pane-down");
  await expect(activeSplitPane(window, "shell 2")).toBeVisible();

  // ...and left from the rightmost still works (proves the no-ops above did not
  // wedge the handler).
  await fireShortcut(app, "focus-pane-left");
  await expect(activeSplitPane(window, "shell 1")).toBeVisible();
});
