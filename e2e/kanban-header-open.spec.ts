import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { KANBAN_STORAGE_KEY, LAYOUT_MODE_STORAGE_KEY } from "../src/storage-keys";

for (const layout of ["projects-left", "stacked", "classic"]) {
  test(`Kanban launcher stays outside drag regions and opens its board in ${layout}`, async ({ window, seeded }, testInfo) => {
    await window.evaluate(({ layoutKey, kanbanKey, layout }) => {
      localStorage.setItem(layoutKey, layout);
      localStorage.setItem(kanbanKey, "1");
    }, { layoutKey: LAYOUT_MODE_STORAGE_KEY, kanbanKey: KANBAN_STORAGE_KEY, layout });
    await window.reload();
    const button = window.getByRole("button", { name: "Kanban", exact: true });
    await expect(button).toBeVisible();
    // Browser-dispatched mouse events bypass Electron's native drag hit test.
    // Pin the computed region as well, or DOM clicks can pass while real clicks fail.
    expect(await button.evaluate(node => getComputedStyle(node).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
    if (layout === "projects-left") {
      const tab = window.getByTestId("termtab").first();
      const tabAppearance = await tab.evaluate(node => {
        const style = getComputedStyle(node);
        return { fontSize: style.fontSize, borderRadius: style.borderRadius, borderTopWidth: style.borderTopWidth, height: node.getBoundingClientRect().height };
      });
      expect(await button.evaluate(node => {
        const style = getComputedStyle(node);
        return { fontSize: style.fontSize, borderRadius: style.borderRadius, borderTopWidth: style.borderTopWidth, height: node.getBoundingClientRect().height };
      })).toEqual(tabAppearance);
      await window.screenshot({ path: testInfo.outputPath("kanban-launcher-inactive.png") });
    }
    await button.click();
    await expect(window.getByTestId("kanban-pane")).toBeVisible();
    if (layout === "projects-left") {
      await expect(button).toHaveClass(/aya-tab--active/);
      await window.screenshot({ path: testInfo.outputPath("kanban-launcher-active.png") });
    }
    await expect(window.locator(".aya-kanban-column")).not.toHaveCount(0);
    const tabs = () => JSON.parse(readFileSync(join(seeded.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs as { id: string; presetId: string }[];
    await expect.poll(() => tabs().filter(tab => tab.presetId === "board")).toHaveLength(1);
    const boardId = tabs().find(tab => tab.presetId === "board")!.id;
    // Switch away before reopening so this exercises selection of the saved board.
    if (layout === "classic") await window.locator(".aya-sidebar-row").first().click();
    else await window.getByTestId("termtab").first().click();
    await expect(window.getByTestId("kanban-pane")).toBeHidden();
    await button.click();
    await expect(window.getByTestId("kanban-pane")).toBeVisible();
    await expect.poll(() => tabs().filter(tab => tab.presetId === "board").map(tab => tab.id)).toEqual([boardId]);
  });
}

test("a crowded strip keeps the Kanban label readable and its keyboard focus inside the tab", async ({ seeded }, testInfo) => {
  const file = join(seeded.ayaHome, "projects", "e2e-proj.json");
  const project = JSON.parse(readFileSync(file, "utf8"));
  project.tabs.push(...Array.from({ length: 6 }, (_, index) => ({ id: `extra-${index}`, presetId: "shell", name: `Additional terminal ${index + 1}` })));
  writeFileSync(file, JSON.stringify(project));
  const app = await launchApp(seeded);
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1000, height: 700 });
    await window.evaluate(({ layoutKey, kanbanKey }) => {
      localStorage.setItem(layoutKey, "projects-left");
      localStorage.setItem(kanbanKey, "1");
    }, { layoutKey: LAYOUT_MODE_STORAGE_KEY, kanbanKey: KANBAN_STORAGE_KEY });
    await window.reload();
    const button = window.getByRole("button", { name: "Kanban", exact: true });
    await window.keyboard.press("Tab");
    await button.focus();
    await expect(button).toBeInViewport({ ratio: 1 });
    expect(await button.evaluate(node => node.matches(":focus-visible"))).toBe(true);
    const label = button.locator(".aya-tab-name");
    const metrics = await label.evaluate(node => ({ full: node.scrollWidth, visible: node.clientWidth }));
    await testInfo.attach("label-width", { body: JSON.stringify(metrics), contentType: "application/json" });
    expect(metrics.full).toBeLessThanOrEqual(metrics.visible);
    expect(await button.evaluate(node => getComputedStyle(node).outlineOffset)).toBe("-2px");
    await window.locator(".aya-topbar").screenshot({ path: testInfo.outputPath("crowded-kanban-keyboard-focus.png") });
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("kanban-pane")).toBeVisible();
  } finally { await closeAndWait(app); }
});
