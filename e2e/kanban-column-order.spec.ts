import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect } from "./fixtures";
import { envWithoutAya } from "./helpers/env";
import { populatedBoard } from "./helpers/kanban";

const originalCard = {
  id: "t-1", title: "Existing task", description: "Keep this card in Todo",
  columnId: "todo", createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
};
const filled = populatedBoard();
const cards = [originalCard, ...filled.cards.filter(card => card.id !== originalCard.id)];
const existingBoard = JSON.stringify({ ...filled, cards });

for (const repo of [false, true]) {
  test.describe(repo ? "repo board" : "user board", () => {
    test.use({ seedOptions: {
      singleTab: { presetId: "board", name: "Board" },
      ...(repo ? { projectFiles: { ".aya/board.json": existingBoard } } : { ayaHomeFiles: { "boards/e2e-proj.json": existingBoard } }),
    } });

    test("add Backlog, move it first with GUI, then reorder from CLI and reload", async ({ window, seeded }, testInfo) => {
      const titles = window.locator(".aya-kanban-column-title");
      const initialOrder = ["Todo", "In Progress", "Review", "Done"];
      await expect(titles).toHaveText(initialOrder);
      await window.getByRole("button", { name: "+ Column", exact: true }).click();
      await window.getByPlaceholder("Column name…").fill("Backlog");
      await window.getByPlaceholder("Column name…").press("Enter");
      await expect(titles).toHaveText([...initialOrder, "Backlog"]);
      await expect(window.getByRole("button", { name: "Move column Backlog right", exact: true })).toBeDisabled();

      for (let index = 3; index >= 0; index--) {
        await window.getByRole("button", { name: "Move column Backlog left", exact: true }).click();
        const expected = [...initialOrder];
        expected.splice(index, 0, "Backlog");
        await expect(titles).toHaveText(expected);
      }
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
      const file = repo ? join(seeded.projectDir, ".aya/board.json") : join(seeded.ayaHome, "boards/e2e-proj.json");
      expect(JSON.parse(readFileSync(file, "utf8")).cards).toEqual(cards);
      await expect(window.locator(".aya-kanban-error")).toHaveCount(0);
    });
  });
}
