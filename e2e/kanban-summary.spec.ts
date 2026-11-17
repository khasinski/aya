import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { BOARD_FILE, boardCard, boardFiles, reloadWithKanban } from "./helpers/board";
import { APP_THEME_STORAGE_KEY } from "../src/storage-keys";

const card = (id: string, columnId: string) => boardCard(id, id, { columnId });
const board = {
  version: 1,
  columns: [{ id: "backlog", title: "Backlog" }, { id: "doing", title: "Doing" }, { id: "done", title: "Done" }],
  cards: [card("t-1", "backlog"), card("t-2", "backlog"), card("t-3", "doing")],
  archivedCards: [card("t-4", "done")],
};

for (const layout of ["projects-left", "stacked", "classic"]) {
  test.describe(layout, () => {
    test.use({ seedOptions: { secondProject: true, ayaHomeFiles: boardFiles(board) } });
    test("summary follows CLI moves, undo, column renames and the active project without opening the board", async ({ window, seeded }, testInfo) => {
      await reloadWithKanban(window, layout);
      const launcher = window.getByRole("button", { name: "Kanban", exact: true });
      await expect(launcher).toHaveAttribute("aria-description", "Backlog: 2 · Doing: 1");
      await expect(window.getByTestId("kanban-pane")).toHaveCount(0);
      if (layout === "projects-left") {
        await expect(launcher.getByTestId("kanban-tab-summary")).toHaveText("Backlog: 2 · Doing: 1");
        await window.locator(".aya-topbar").screenshot({ path: testInfo.outputPath("kanban-live-summary.png") });
      }
      await new Promise<void>((resolveExit, reject) => {
        const child = spawn(resolve("bin/aya"), ["board", "move", "t-1", "done", "--project", "e2e-proj"], {
          cwd: seeded.projectDir, detached: true,
          env: { ...envWithoutAya(), AYA_SOCKET: join(seeded.ayaHome, "aya.sock") },
        });
        let stderr = "";
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolveExit() : reject(new Error(`aya exited ${code}: ${stderr}`)));
      });
      await expect(launcher).toHaveAttribute("aria-description", "Backlog: 1 · Doing: 1 · Done: 1");
      await window.evaluate(() => window.aya.moveBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", columnId: "backlog" }));
      await expect(launcher).toHaveAttribute("aria-description", "Backlog: 2 · Doing: 1");
      await window.evaluate(() => window.aya.renameBoardColumn({ projectSlug: "e2e-proj", columnId: "doing", title: "In development" }));
      await expect(launcher).toHaveAttribute("title", /Backlog: 2 · In development: 1/);

      const project = (slug: string) => window.locator(`[data-project-slug="${slug}"]`).first();
      await project("e2e-proj-2").click();
      await expect(launcher).toHaveAttribute("aria-description", "No cards");
      // Changes to an inactive project's board must not replace the active summary.
      await window.evaluate(() => window.aya.deleteBoardCard({ projectSlug: "e2e-proj", cardId: "t-3" }));
      await expect(launcher).toHaveAttribute("aria-description", "No cards");
      await project("e2e-proj").click();
      await expect(launcher).toHaveAttribute("aria-description", "Backlog: 2");
      // Wait for the debounced selection writer before reloading; otherwise a slow
      // machine reloads first and restores the previously saved project.
      await expect.poll(() => JSON.parse(readFileSync(join(seeded.ayaHome, "projects-state.json"), "utf8")).activeProject)
        .toBe("e2e-proj");
      await window.reload();
      await expect(launcher).toHaveAttribute("aria-description", "Backlog: 2");
    });
  });
}

test.describe("unreadable board", () => {
  test.use({ seedOptions: { ayaHomeFiles: { [BOARD_FILE]: "invalid json" } } });
  test("shows unavailable instead of an empty board and recovers on the next change", async ({ window, seeded }) => {
    await reloadWithKanban(window, "projects-left");
    const summary = window.getByTestId("kanban-tab-summary");
    await expect(summary).toHaveText("Board unavailable");
    writeFileSync(join(seeded.ayaHome, BOARD_FILE), JSON.stringify(board));
    await window.evaluate(() => window.aya.moveBoardCard({ projectSlug: "e2e-proj", cardId: "t-1", columnId: "done" }));
    await expect(summary).toHaveText("Backlog: 1 · Doing: 1 · Done: 1");
  });
});

test.describe("external board changes", () => {
  test.use({ seedOptions: { ayaHomeFiles: boardFiles(board) } });
  test("opening the board refreshes a summary after a direct file change", async ({ window, seeded }) => {
    await reloadWithKanban(window, "projects-left");
    const launcher = window.getByRole("button", { name: "Kanban", exact: true });
    await expect(launcher).toHaveAttribute("aria-description", "Backlog: 2 · Doing: 1");
    const changed = { ...board, cards: board.cards.map(card => ({ ...card, columnId: "done" })) };
    writeFileSync(join(seeded.ayaHome, BOARD_FILE), JSON.stringify(changed));
    await launcher.focus();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("kanban-column-done").locator(".aya-kanban-card")).toHaveCount(3);
    await expect(launcher).toHaveAttribute("aria-description", "Done: 3");
  });
});

test.describe("five populated columns", () => {
  const columns = [
    { id: "backlog", title: "Backlog", count: 12 },
    { id: "todo", title: "Todo", count: 8 },
    { id: "in-progress", title: "In Progress", count: 3 },
    { id: "review", title: "Review", count: 2 },
    { id: "done", title: "Done", count: 21 },
  ];
  const fiveColumnBoard = {
    version: 1,
    columns: columns.map(({ id, title }) => ({ id, title })),
    cards: columns.flatMap(column => Array.from({ length: column.count }, (_, index) => ({
      ...card(`${column.id}-${index + 1}`, column.id),
      title: `${column.title}: project task ${index + 1}`,
      description: "Implementation, verification and delivery of a project task.",
    }))),
  };
  test.use({ seedOptions: { ayaHomeFiles: boardFiles(fiveColumnBoard) } });
  test("keeps a five-status summary within its tab at wide and narrow window sizes", async ({ window }, testInfo) => {
    await window.setViewportSize({ width: 1920, height: 850 });
    await reloadWithKanban(window, "projects-left", { [APP_THEME_STORAGE_KEY]: "dark" });
    const launcher = window.getByRole("button", { name: "Kanban", exact: true });
    const expected = "Backlog: 12 · Todo: 8 · In Progress: 3 · Review: 2 · Done: 21";
    await expect(launcher.getByTestId("kanban-tab-summary")).toHaveText(expected);
    await expect(launcher).toHaveAttribute("title", `Open Kanban board for this project\n${expected}`);
    await launcher.click();
    await expect(window.locator(".aya-kanban-column")).toHaveCount(5);
    await expect(window.locator(".aya-kanban-card")).toHaveCount(46);
    for (const column of columns) {
      await expect(window.getByTestId(`kanban-column-${column.id}`)).toBeInViewport({ ratio: 0.95 });
    }
    await window.screenshot({ path: testInfo.outputPath("five-column-board.png") });
    await window.locator(".aya-topbar").screenshot({ path: testInfo.outputPath("five-column-summary-wide.png") });
    await window.setViewportSize({ width: 1000, height: 700 });
    await expect(launcher).toBeInViewport({ ratio: 1 });
    const summary = launcher.getByTestId("kanban-tab-summary");
    expect(await summary.evaluate(node => {
      const style = getComputedStyle(node);
      return style.textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth;
    })).toBe(true);
    await window.locator(".aya-topbar").screenshot({ path: testInfo.outputPath("five-column-summary-narrow.png") });
  });
});
