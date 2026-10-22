import { expect, test } from "./fixtures";
import { reloadInProjectsLeftLayout } from "./helpers/layout";

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

  test("classic project tabs and terminal rows use roving keyboard focus", async ({ window }) => {
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
    await expect(projectTabs.getByRole("button", { name: /Close project/ }).first()).toHaveAttribute("type", "button");
    await tabs.nth(1).screenshot({ path: "/tmp/a11y-pr2-focus-project-tab.png" });

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
    await expect(rows.getByRole("button", { name: /Close terminal/ }).first()).toHaveAttribute("type", "button");
    await rows.first().screenshot({ path: "/tmp/a11y-pr2-focus-sidebar-row.png" });
  });

  test("keyboard context-menu shortcuts focus the menu and restore the row", async ({ window }) => {
    const row = window.getByRole("list", { name: "Terminals" }).getByRole("listitem").first();
    await row.focus();
    await window.keyboard.press("Shift+F10");
    const menu = window.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button").first()).toBeFocused();
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

  test("projects-left project list and terminal tabs are keyboard-operable", async ({ window }) => {
    await reloadInProjectsLeftLayout(window);
    const projects = window.getByRole("list", { name: "Projects" }).getByRole("listitem");
    await expect(projects).toHaveCount(2);
    await projects.first().focus();
    await window.keyboard.press("ArrowDown");
    await expect(projects.nth(1)).toBeFocused();
    await expect(projects.first()).toHaveAttribute("aria-current", "true");
    await window.keyboard.press("Enter");
    await expect(projects.nth(1)).toHaveAttribute("aria-current", "true");
    await expect(window.getByRole("button", { name: /Close project/ }).first()).toHaveAttribute("type", "button");

    const terminals = window.getByRole("tablist", { name: "Terminals" }).getByRole("tab");
    await expect(terminals).toHaveCount(1);
    await terminals.first().focus();
    await window.keyboard.press("Enter");
    await expect(terminals.first()).toHaveAttribute("aria-selected", "true");
    await expect(window.getByRole("button", { name: /Close terminal/ }).first()).toHaveAttribute("type", "button");
    await terminals.first().focus();
    await window.keyboard.press("Shift+F10");
    const menu = window.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("button").first()).toBeFocused();
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
