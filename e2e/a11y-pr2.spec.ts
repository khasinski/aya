import { expect, test } from "./fixtures";
import { reloadInProjectsLeftLayout } from "./helpers/layout";
import { fireShortcut } from "./helpers/shortcut";

async function dragProjectAfter(window: import("@playwright/test").Page) {
  const source = '.aya-project-tablist [role="tab"]:first-child';
  const target = '.aya-project-tablist [role="tab"]:last-child';
  for (const which of ["dragstart", "dragover", "drop", "dragend"] as const) {
    await window.evaluate(({ source, target, which }) => {
      const w = window as unknown as { __a11yDataTransfer?: DataTransfer };
      if (which === "dragstart") w.__a11yDataTransfer = new DataTransfer();
      const sourceElement = document.querySelector(source)!;
      const targetElement = document.querySelector(target)!;
      const rect = targetElement.getBoundingClientRect();
      const event = new DragEvent(which, {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width * 0.75,
        clientY: rect.top + rect.height / 2,
      });
      Object.defineProperty(event, "dataTransfer", { value: w.__a11yDataTransfer });
      (which === "dragstart" || which === "dragend" ? sourceElement : targetElement).dispatchEvent(event);
    }, { source, target, which });
  }
}

test.describe("keyboard access to project and terminal lists", () => {
  test.use({ seedOptions: { secondProject: true } });

  test("classic project tabs and terminal rows use roving keyboard focus", async ({ app, window }) => {
    await fireShortcut(app, "open-settings");
    const settings = window.locator(".aya-modal--settings");
    await expect(settings).toBeVisible();
    await settings.getByTestId("appearance-segment").filter({ hasText: "Dark" }).click();
    await window.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    const projectTabs = window.getByRole("tablist", { name: "Projects" });
    const tabs = projectTabs.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await tabs.first().focus();
    await window.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("ArrowLeft");
    await expect(tabs.first()).toBeFocused();
    await tabs.nth(1).focus();
    await window.keyboard.press("Enter");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    const projectClose = projectTabs.locator(".aya-tab-close").first();
    await expect(projectClose).toHaveAttribute("type", "button");
    await expect(projectClose).toHaveAttribute("tabindex", "-1");
    // Capture keyboard-visible focus, not only the selected-tab underline.
    await tabs.first().focus();
    await window.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    expect(await tabs.nth(1).evaluate((tab) => tab.matches(":focus-visible"))).toBe(true);
    await tabs.nth(1).screenshot({ path: "/tmp/a11y-pr2-focus-project-tab-dark.png" });

    // The first seeded project contains two terminals; the second project is a
    // separate one-terminal project used by the rail navigation checks below.
    await tabs.first().focus();
    await window.keyboard.press("Enter");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

    const rows = window.getByRole("list", { name: "Terminals" }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await rows.first().focus();
    await window.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.first()).toHaveAttribute("aria-current", "true");
    await window.keyboard.press("ArrowUp");
    await expect(rows.first()).toBeFocused();
    await rows.nth(1).focus();
    await window.keyboard.press("Space");
    await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
    const terminalClose = rows.locator(".aya-sidebar-close").first();
    await expect(terminalClose).toHaveAttribute("type", "button");
    await expect(terminalClose).toHaveAttribute("tabindex", "-1");
    await rows.nth(1).screenshot({ path: "/tmp/a11y-pr2-focus-sidebar-row-dark.png" });

    await fireShortcut(app, "open-settings");
    const lightSettings = window.locator(".aya-modal--settings");
    await lightSettings.getByTestId("appearance-segment").filter({ hasText: "Light" }).click();
    await window.keyboard.press("Escape");
    await rows.nth(1).focus();
    await rows.nth(1).screenshot({ path: "/tmp/a11y-pr2-focus-sidebar-row-light.png" });
  });

  test("keyboard context-menu shortcuts focus the menu and restore the row", async ({ window }) => {
    const row = window.getByRole("list", { name: "Terminals" }).getByRole("listitem").first();
    await window.bringToFront();
    await expect.poll(() => window.evaluate(() => document.hasFocus())).toBe(true);
    await row.focus();
    await expect(row).toBeFocused();
    await window.keyboard.press("Shift+F10");
    const menu = window.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[role="menuitem"]:not(:disabled)').first()).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(row).toBeFocused();

    await row.evaluate((element) => element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }),
    ));
    await expect(menu).toBeVisible();
    await window.keyboard.press("Escape");
  });

  test("project tabs still reorder with a mouse drag", async ({ window }) => {
    const tabs = window.locator('.aya-project-tablist [role="tab"]');
    await expect(tabs).toHaveCount(2);
    const original = await tabs.allTextContents();
    await dragProjectAfter(window);
    await expect.poll(() => tabs.allTextContents()).toEqual([original[1], original[0]]);
  });

  test("context menus move project tabs and terminal rows with the keyboard", async ({ window }) => {
    const projectTabs = window.locator('.aya-project-tablist [role="tab"]');
    await expect(projectTabs).toHaveCount(2);
    const projectSlugs = await projectTabs.evaluateAll((items) => items.map((item) => item.getAttribute("data-project-slug")));
    await projectTabs.nth(1).focus();
    await window.keyboard.press("Shift+F10");
    const projectMenu = window.getByRole("menu");
    const moveProjectLeft = projectMenu.getByRole("menuitem", { name: "Move left" });
    await expect(moveProjectLeft).toBeEnabled();
    await expect(projectMenu.getByRole("menuitem", { name: "Move right" })).toBeDisabled();
    await moveProjectLeft.focus();
    await window.keyboard.press("ArrowDown");
    const closeProjectItem = projectMenu.getByRole("menuitem", { name: "Close project" });
    await expect(closeProjectItem).toBeFocused();
    await closeProjectItem.evaluate((item) => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    await expect(moveProjectLeft).toBeFocused();
    await moveProjectLeft.evaluate((item) => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await expect.poll(() => projectTabs.evaluateAll((items) => items.map((item) => item.getAttribute("data-project-slug"))))
      .toEqual([projectSlugs[1], projectSlugs[0]]);
    await expect(window.locator('[data-project-slug="' + projectSlugs[1] + '"]')).toBeFocused();

    const rows = window.getByRole("list", { name: "Terminals" }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    const firstRow = rows.first();
    const firstName = await firstRow.getAttribute("data-terminal-name");
    const secondName = await rows.nth(1).getAttribute("data-terminal-name");
    await firstRow.focus();
    await window.keyboard.press("Shift+F10");
    const terminalMenu = window.getByRole("menu");
    await expect(terminalMenu.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
    const moveDown = terminalMenu.getByRole("menuitem", { name: "Move down" });
    await expect(moveDown).toBeEnabled();
    const firstEnabledTerminalItem = terminalMenu.locator('[role="menuitem"]:not(:disabled)').first();
    await firstEnabledTerminalItem.focus();
    await window.keyboard.press("ArrowDown");
    await expect(terminalMenu.locator('[role="menuitem"]:not(:disabled)').nth(1)).toBeFocused();
    await terminalMenu.locator('[role="menuitem"]:not(:disabled)').nth(1).evaluate((item) => item.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    await expect(terminalMenu.locator('[role="menuitem"]:not(:disabled)').last()).toBeFocused();
    await terminalMenu.locator('[role="menuitem"]:not(:disabled)').last().evaluate((item) => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    await expect(firstEnabledTerminalItem).toBeFocused();
    await moveDown.focus();
    await moveDown.evaluate((item) => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await expect.poll(() => window.getByTestId("sidebar-terminal").evaluateAll((items) => items.map((item) => item.getAttribute("data-terminal-name"))))
      .toEqual([secondName, firstName]);
    await expect(window.locator('[data-testid="sidebar-terminal"][data-terminal-name="' + firstName + '"]')).toBeFocused();
  });

  test("Delete closes a focused item without a second tab stop on the close button", async ({ window }) => {
    const projectTab = window.locator('.aya-project-tablist [role="tab"]').nth(1);
    const closeButton = projectTab.locator(".aya-tab-close");
    await expect(projectTab.locator(".aya-tab-close")).toHaveAttribute("aria-hidden", "true");
    await expect(closeButton).toHaveAttribute("tabindex", "-1");
    await projectTab.focus();
    await window.keyboard.press("Delete");
    await expect(window.locator('.aya-project-tablist [role="tab"]')).toHaveCount(1);
  });

  test("projects-left project list and terminal tabs are keyboard-operable", async ({ window }) => {
    await reloadInProjectsLeftLayout(window);
    const projects = window.getByRole("list", { name: "Projects" }).getByRole("listitem");
    await expect(projects).toHaveCount(2);
    await projects.first().focus();
    await expect(projects.first()).toBeFocused();
    await window.keyboard.press("ArrowDown");
    await expect(projects.nth(1)).toBeFocused();
    await expect(projects.first()).toHaveAttribute("aria-current", "true");
    await window.keyboard.press("Enter");
    await expect(projects.nth(1)).toHaveAttribute("aria-current", "true");
    const railProjectClose = window.locator(".aya-railtab-close").first();
    await expect(railProjectClose).toHaveAttribute("type", "button");
    await expect(railProjectClose).toHaveAttribute("tabindex", "-1");

    const terminals = window.getByRole("tablist", { name: "Terminals" }).getByRole("tab");
    await expect(terminals).toHaveCount(1);
    await terminals.first().focus();
    await window.keyboard.press("Enter");
    await expect(terminals.first()).toHaveAttribute("aria-selected", "true");
    const railTerminalClose = window.locator(".aya-tab-close").last();
    await expect(railTerminalClose).toHaveAttribute("type", "button");
    await expect(railTerminalClose).toHaveAttribute("tabindex", "-1");
    await terminals.first().focus();
    await window.keyboard.press("Shift+F10");
    const menu = window.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[role="menuitem"]:not(:disabled)').first()).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(terminals.first()).toBeFocused();
  });

  test("Ctrl+Tab leaves the terminal, Ctrl+Shift+Tab returns, and Tab still reaches the PTY", async ({ app, window }) => {
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> };
      const original = handlers._invokeHandlers.get("pty:write");
      if (!original) throw new Error("pty:write handler is unavailable");
      (globalThis as typeof globalThis & { __a11yTabWrites?: string[] }).__a11yTabWrites = [];
      ipcMain.removeHandler("pty:write");
      ipcMain.handle("pty:write", (event: unknown, id: string, data: string) => {
        (globalThis as typeof globalThis & { __a11yTabWrites: string[] }).__a11yTabWrites.push(data);
        return original(event, id, data);
      });
    });

    await window.bringToFront();
    await expect.poll(() => window.evaluate(() => document.hasFocus())).toBe(true);
    const terminalInput = window.locator('.aya-pane[style*="display: flex"] .xterm-helper-textarea').first();
    await terminalInput.focus();
    await window.keyboard.press("Tab");
    await expect.poll(() => app.evaluate(() =>
      (globalThis as typeof globalThis & { __a11yTabWrites: string[] }).__a11yTabWrites.includes("\t"),
    )).toBe(true);

    await window.keyboard.press("Control+Tab");
    const activeRow = window.locator('.aya-sidebar-row[aria-current="true"]');
    await expect(activeRow).toBeFocused();
    await activeRow.screenshot({ path: "/tmp/a11y-pr2-focus-terminal-region.png" });
    await window.keyboard.press("Control+Shift+Tab");
    await expect(terminalInput).toBeFocused();
  });
});
