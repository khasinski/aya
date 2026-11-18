import { test, expect } from "./fixtures";
import { boardCard, openShelf, readBoardFile, seedBoard, setBacklogOnShelf, shelfTab } from "./helpers/board";

// The shelf button is always on the board's toolbar, also while the shelf is empty, and
// the shelf's Backlog tab takes new cards: with Move backlog to shelf on, the board
// hides its Backlog column, so the tab is the only place to add a card to it.
const columns = [{ id: "todo", title: "Todo" }, { id: "done", title: "Done" }];
const backlogFirst = [{ id: "backlog", title: "Backlog" }, ...columns];
const cards = [boardCard("t-1", "Now"), boardCard("t-2", "Shipped", { columnId: "done" })];

test.describe("an empty archive, no Backlog column", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns, cards }) });

  test("the shelf button shows and opens an empty Archive", async ({ window }, testInfo) => {
    const toggle = window.getByTestId("kanban-archive-toggle");
    await expect(toggle).toHaveText("Archive (0)");
    const drawer = await openShelf(window);
    await expect(drawer.getByText("Archive is empty.", { exact: false })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "+ Add card" })).toHaveCount(0);
    await window.locator(".aya-kanban-toolbar-meta").screenshot({ path: testInfo.outputPath("toolbar-empty-archive.png") });
  });
});

test.describe("an empty Backlog column on the shelf", () => {
  test.use({ seedOptions: seedBoard({ version: 1, columns: backlogFirst, cards }) });

  test("the shelf button shows, and the Backlog tab adds a card to the Backlog column", async ({ window, app, seeded }, testInfo) => {
    await setBacklogOnShelf(window, app, true);
    await expect(window.getByTestId("kanban-column-backlog")).toHaveCount(0);
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Shelf (0)");
    const drawer = await openShelf(window);
    const addCard = drawer.getByRole("button", { name: "+ Add card" });
    // Add card belongs to the Backlog tab only.
    await expect(addCard).toHaveCount(0);
    await shelfTab(drawer, "Backlog").click();
    await expect(drawer.getByText("Backlog is empty. Use + Add card", { exact: false })).toBeVisible();

    // Leaving the tab drops a half-typed form: the hidden column has nowhere else to show it.
    await addCard.click();
    await drawer.getByLabel("Card title").fill("Draft");
    await expect(drawer.getByText("Backlog is empty.", { exact: false })).toHaveCount(0);
    await drawer.screenshot({ path: testInfo.outputPath("shelf-backlog-form.png") });
    await shelfTab(drawer, "Archive").click();
    await shelfTab(drawer, "Backlog").click();
    await expect(drawer.getByLabel("Card title")).toHaveCount(0);

    await addCard.click();
    await drawer.getByLabel("Card title").fill("Someday idea");
    await drawer.getByLabel("Card title").press("Enter");

    await expect(drawer.getByText("Someday idea")).toBeVisible();
    await expect(window.getByTestId("kanban-archive-toggle")).toHaveText("Shelf (1)");
    const added = readBoardFile(seeded.ayaHome).cards.find((c: { title: string }) => c.title === "Someday idea");
    expect(added?.columnId).toBe("backlog");
    await drawer.screenshot({ path: testInfo.outputPath("shelf-backlog-added.png") });
  });
});
