import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { seedCodexGui } from "./helpers/codex-gui";
import { fireShortcut } from "./helpers/shortcut";

function twoConversations(split = false) {
  const seed = seedCodexGui();
  const file = join(seed.ayaHome, "projects/e2e-proj.json");
  const project = JSON.parse(readFileSync(file, "utf8"));
  project.tabs.push({ id: "gui-right", presetId: "gui", name: "Second GUI" });
  if (split) project.splitLayout = { rows: 1, cols: 2, rowFr: [1], colFr: [1, 1], cells: [seed.tabIds.left, "gui-right"], activeCell: 0 };
  writeFileSync(file, JSON.stringify(project));
  return seed;
}

test("Stacked Kanban header controls accept native mouse clicks", async () => {
  const seed = seedCodexGui(), app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".aya-gui-header").getByRole("status")).toHaveText("Ready");
    await page.evaluate(() => {
      localStorage.setItem("aya:kanban", "1");
      localStorage.setItem("aya:layout-mode", "stacked");
    });
    await page.reload();
    await page.getByRole("button", { name: "Kanban", exact: true }).click();
    const header = page.locator(".aya-stacked-headerslot");
    const search = header.getByRole("searchbox", { name: "Filter cards" });
    await expect(search).toBeVisible();
    // CDP mouse events bypass Electron's native draggable-region hit testing.
    expect(await search.evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-app-region"))).toBe("no-drag");
    await expect(header.getByRole("button", { name: "+ Column", exact: true })).toHaveCSS("-webkit-app-region", "no-drag");
    await header.getByRole("button", { name: "+ Column", exact: true }).click();
    await expect(header.getByPlaceholder("Column name…")).toHaveCSS("-webkit-app-region", "no-drag");
    await header.getByPlaceholder("Column name…").fill("Backlog");
    await header.getByPlaceholder("Column name…").press("Enter");
    await expect(page.getByTestId("kanban-column-backlog")).toBeVisible();
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test("workspace file preview closes when switching away from its conversation", async () => {
  const seed = twoConversations(), app = await launchApp(seed);
  try {
    writeFileSync(join(seed.projectDir, "review.ts"), "review target");
    const page = await app.firstWindow();
    const first = page.locator(".aya-conversation").nth(0);
    await expect(first.locator("header").getByRole("status")).toHaveText("Ready");
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send("codex-gui:event", id, {
      method: "item/completed", params: { item: { id: "file-link", type: "agentMessage", text: "[Review source](review.ts)" } },
    }), seed.tabIds.left);
    await first.getByRole("link", { name: "Review source" }).click();
    const preview = page.getByRole("dialog", { name: "Workspace file preview" });
    await expect(preview).toContainText("review target");
    await fireShortcut(app, "next-tab");
    await expect(first).toBeHidden();
    expect(await preview.count()).toBe(0);
    await fireShortcut(app, "prev-tab");
    await expect(first).toBeVisible();
    await expect(preview).toHaveCount(0);
    await first.getByRole("link", { name: "Review source" }).click();
    await expect(preview).toContainText("review target");
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test("a failed split conversation keeps its bounds and releases its agent when closed", async () => {
  const seed = twoConversations(true), app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    const right = page.locator(".aya-conversation").nth(1);
    const left = page.locator(".aya-conversation").nth(0);
    await expect(right.locator("header").getByRole("status")).toHaveText("Ready");
    const prompt = right.getByRole("textbox", { name: "Message Codex" });
    await prompt.fill("wait"); await prompt.press("Enter");
    await expect(right.getByRole("status", { name: "Turn status" })).toContainText("is working");
    const isBusy = () => app.evaluate(({}, root) => {
      const require = process.getBuiltinModule("module").createRequire(root + "/package.json");
      return require(root + "/dist-electron/codex-gui-ipc.js").isGuiSessionBusy("gui-right");
    }, resolve("."));
    const bounds = await right.boundingBox();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("codex-gui:event", "gui-right", {
      method: "turn/plan/updated", params: { plan: [{ step: { invalid: true }, status: "pending" }] },
    }));
    const failure = page.getByRole("alert").filter({ hasText: "Conversation could not be displayed" });
    await expect(failure).toBeVisible();
    expect(await isBusy()).toBe(true);
    expect(await failure.evaluate(el => getComputedStyle(el).position)).toBe("absolute");
    const failedBounds = await failure.boundingBox();
    for (const dimension of ["x", "y", "width", "height"] as const) expect(failedBounds![dimension]).toBeCloseTo(bounds![dimension], 0);
    await failure.getByText("Conversation could not be displayed").click();
    await expect(failure).toHaveClass(/aya-pane--active-split/);
    await expect(left).toBeVisible();
    await left.getByRole("textbox", { name: "Message Codex" }).fill("The other pane still works");
    await expect(left.getByRole("textbox", { name: "Message Codex" })).toHaveValue("The other pane still works");
    await failure.getByText("Conversation could not be displayed").click();
    await fireShortcut(app, "close-tab");
    await expect(failure).toHaveCount(0);
    await expect.poll(isBusy).toBe(false);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
