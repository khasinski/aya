// "Stacked" layout: no tabs on top; projects and the project's terminals in two boxes on the left (each scrolling
// inside itself); the active terminal's header sits in the top bar.
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

test("stacked layout: terminals under projects, header in the top bar, scrolling inside the box", async ({ window, app }) => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 560));
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.locator('.aya-settings-segmented[aria-label="Window layout"] button', { hasText: "Stacked" }).click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // No tabs on top; the two boxes are on the left, terminals under projects.
  await expect(window.locator(".aya-topbar--stacked")).toBeVisible();
  await expect(window.locator(".aya-topbar .aya-termtabs")).toHaveCount(0);
  const projects = window.locator(".aya-projectrail--stacked .aya-projectrail-list");
  const terminals = window.locator(".aya-stacked-terminals");
  await expect(projects.getByTestId("railtab")).toHaveCount(1);
  const tabs = terminals.getByTestId("termtab");
  await expect(tabs).toHaveCount(2);
  const [first, second, box1, box2] = await Promise.all([tabs.nth(0).boundingBox(), tabs.nth(1).boundingBox(), projects.boundingBox(), terminals.boundingBox()]);
  expect(second!.y).toBeGreaterThan(first!.y + first!.height - 1);
  expect(Math.abs(second!.x - first!.x)).toBeLessThan(2);
  expect(box2!.y).toBeGreaterThanOrEqual(box1!.y + box1!.height - 1);

  // The terminal's header takes the tabs' place in the top bar, and follows the selection.
  const header = window.locator(".aya-topbar .aya-stacked-headerslot .aya-pane-header-title");
  await expect(header).toHaveText("shell 1");
  await tabs.nth(1).click();
  await expect(header).toHaveText("shell 2");
  await expect(window.locator('[data-testid="terminal-pane"]:visible .aya-pane-header')).toHaveCount(0);

  // Many terminals scroll inside their own box, not the window.
  for (let i = 0; i < 8; i++) {
    await terminals.getByRole("button", { name: "New terminal" }).click();
    await window.getByRole("menuitem", { name: /Shell/ }).first().click();
  }
  await expect(tabs).toHaveCount(10);
  const list = window.locator(".aya-termtabs--stacked");
  const metrics = await list.evaluate((el) => ({ scrollable: el.scrollHeight > el.clientHeight + 1, overflowY: getComputedStyle(el).overflowY }));
  expect(metrics).toEqual({ scrollable: true, overflowY: "auto" });
  expect(await window.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  await expect(terminals.getByRole("button", { name: "New terminal" })).toBeVisible();
});
