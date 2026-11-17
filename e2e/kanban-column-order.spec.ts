import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { BOARD_FILE, BOARD_TAB, boardCard, populatedBoard, seedBoard } from "./helpers/board";

const originalCard = boardCard("t-1", "Existing task", { description: "Keep this card in Todo" });
const filled = populatedBoard();
const cards = [originalCard, ...filled.cards.filter(card => card.id !== originalCard.id)];
const existingBoard = { ...filled, cards };
/** The board a repository keeps for itself, relative to the project dir. */
const REPO_BOARD_FILE = ".aya/board.json";

for (const repo of [false, true]) {
  test.describe(repo ? "repo board" : "user board", () => {
    test.use({ seedOptions: repo
      ? { singleTab: BOARD_TAB, projectFiles: { [REPO_BOARD_FILE]: JSON.stringify(existingBoard) } }
      : seedBoard(existingBoard, { pane: "single" }) });

    test("add Backlog (it goes first), reorder with GUI and CLI, and reload", async ({ window, seeded }, testInfo) => {
      const titles = window.locator(".aya-kanban-column-title");
      const initialOrder = ["Todo", "In Progress", "Review", "Done"];
      await expect(titles).toHaveText(initialOrder);
      await window.getByRole("button", { name: "+ Column", exact: true }).click();
      await window.getByPlaceholder("Column name…").fill("Backlog");
      await window.getByPlaceholder("Column name…").press("Enter");
      // A newly created Backlog column is always FIRST (Justyna's rule).
      await expect(titles).toHaveText(["Backlog", ...initialOrder]);
      await expect(window.getByRole("button", { name: "Move column Backlog left", exact: true })).toBeDisabled();
      await expect(window.getByTestId("kanban-column-backlog")).toBeInViewport({ ratio: 0.95 });
      await expect(window.getByTestId("kanban-column-todo")).toContainText("Existing task");
      await expect(window.getByTestId("kanban-column-backlog")).not.toContainText("Existing task");
      await window.screenshot({ path: testInfo.outputPath("backlog-first.png") });

      // Keyboard activation uses the same API and persists the new order.
      await window.getByRole("button", { name: "Move column Backlog right", exact: true }).focus();
      await window.keyboard.press("Enter");
      await expect(titles).toHaveText(["Todo", "Backlog", "In Progress", "Review", "Done"]);
      await window.reload();
      await expect(titles).toHaveText(["Todo", "Backlog", "In Progress", "Review", "Done"]);

      // The real CLI notifies the already-open board; no renderer reload needed.
      const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(resolve("bin/aya"), ["board", "column", "move", "backlog", "--after", "done", "--project", "e2e-proj"], {
          cwd: seeded.projectDir, detached: true,
          env: { ...envWithoutAya(), AYA_SOCKET: join(seeded.ayaHome, "aya.sock") },
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolveOutput(stdout) : reject(new Error(`aya exited ${code}: ${stderr}`)));
      });
      expect(output).toContain("moved column backlog after done");
      await expect(titles).toHaveText([...initialOrder, "Backlog"]);
      const file = repo ? join(seeded.projectDir, REPO_BOARD_FILE) : join(seeded.ayaHome, BOARD_FILE);
      expect(JSON.parse(readFileSync(file, "utf8")).cards).toEqual(cards);
      await expect(window.locator(".aya-kanban-error")).toHaveCount(0);
    });
  });
}
