import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { reloadWithKanban } from "./helpers/board";
import { seedCodexGui } from "./helpers/codex-gui";

for (const layout of ["classic", "projects-left", "stacked"]) {
  test(`Kanban opens and reopens from a conversation in ${layout}`, async () => {
    const seed = seedCodexGui();
    const app = await launchApp(seed);
    try {
      const page = await app.firstWindow();
      await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
      await reloadWithKanban(page, layout);
      const toggle = page.getByRole("button", { name: "Kanban", exact: true });
      await expect(toggle).toBeVisible();
      // CDP clicks bypass Electron's native window-drag hit testing. A titlebar
      // control must opt out explicitly or real mouse clicks drag the window.
      expect(await toggle.evaluate(el =>
        getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
      await toggle.click();
      const board = page.getByTestId("kanban-pane");
      await expect(board).toBeVisible();
      await expect(page.locator(".aya-kanban-column-title")).toHaveText(["Todo", "In Progress", "Review", "Done"]);

      await page.locator('[data-terminal-name="Codex GUI"]').click();
      await expect(board).toHaveCount(0);
      await toggle.click();
      await expect(board).toBeVisible();
      const boardId = await board.getAttribute("data-terminal-id");
      // Wait for the debounced selection writer before simulating a restart.
      await expect.poll(() => JSON.parse(readFileSync(join(seed.ayaHome, "projects-state.json"), "utf8"))
        .activeTab?.["e2e-proj"]).toBe(boardId);
      await page.reload();
      await expect(board).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-current", "true");
    } finally {
      await closeAndWait(app);
      rmSync(seed.root, { recursive: true, force: true });
    }
  });
}
