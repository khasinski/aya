import { test, expect } from "./fixtures";

// Multi-window (P1+P2): tearing a project tab out into a new window via the
// tab context menu. The moved project must appear in the second window with
// its terminal attached (PTYs survive the move - they live in the detached
// host), and disappear from the first window without landing in "recent".

test.use({ seedOptions: { split: false } });

test("Move to New Window tears the project out; terminals survive", async ({
  window,
  app,
}) => {
  // Seeded: one project "e2e" with one shell tab in window 1.
  const tab = window.locator(".aya-tab");
  await expect(tab).toHaveCount(1);
  await expect(window.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(1);

  // Right-click the tab -> Move to New Window.
  await tab.first().click({ button: "right" });
  const menuItem = window.locator(".aya-context-menu-item", {
    hasText: "Move to New Window",
  });
  await expect(menuItem).toBeVisible();
  const windowPromise = app.waitForEvent("window");
  await menuItem.click();

  // A second window opens and adopts the project...
  const win2 = await windowPromise;
  await win2.waitForLoadState("domcontentloaded");
  await expect(win2.locator(".aya-tab")).toHaveCount(1);
  await expect(win2.locator(".aya-tab").first()).toContainText("e2e");
  // ...with the terminal re-attached (same tab name, no fresh spawn needed).
  await expect(
    win2.locator('[data-testid="terminal-pane"][data-terminal-name="shell 1"]'),
  ).toBeVisible();

  // Chrome semantics: the source window lost its last tab, so it closes
  // itself instead of lingering as a hidden empty window (which would show up
  // as a phantom "Move to window…" target).
  await expect.poll(() => window.isClosed()).toBe(true);
});

test("round-trip: detach, reattach, no phantom window target remains", async ({
  window,
  app,
}) => {
  // Detach the (only) project into a new window; the source window closes.
  await window.locator(".aya-tab").first().click({ button: "right" });
  const win2Promise = app.waitForEvent("window");
  await window
    .locator(".aya-context-menu-item", { hasText: "Move to New Window" })
    .click();
  const win2 = await win2Promise;
  await win2.waitForLoadState("domcontentloaded");
  await expect(win2.locator(".aya-tab")).toHaveCount(1);
  await expect.poll(() => window.isClosed()).toBe(true);

  // Detach AGAIN from the surviving window: the context menu must offer ONLY
  // "Move to New Window" - no phantom entry for the closed source window
  // (the reported bug: a hidden/dead window kept showing up as a target).
  await win2.locator(".aya-tab").first().click({ button: "right" });
  const menuItems = win2.locator(".aya-context-menu-item");
  await expect(menuItems).toHaveCount(1);
  await expect(menuItems.first()).toContainText("Move to New Window");
  await win2.keyboard.press("Escape");

  // And the app is down to exactly one live window.
  const windowCount = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
  );
  expect(windowCount).toBe(1);
});

test("File menu New Window opens an empty second window", async ({
  window,
  app,
}) => {
  await expect(window.locator(".aya-tab")).toHaveCount(1);
  const windowPromise = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.find((i) => i.label === "File")
      ?.submenu?.items.find((i) => i.label === "New Window");
    item?.click();
  });
  const win2 = await windowPromise;
  await win2.waitForLoadState("domcontentloaded");
  // Empty window: no project tabs; the original window is untouched.
  await expect(win2.locator(".aya-tab")).toHaveCount(0);
  await expect(window.locator(".aya-tab")).toHaveCount(1);
});
