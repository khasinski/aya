import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, launchApp, closeAndWait } from "./fixtures";
import { populatedBoard } from "./helpers/kanban";

const board = populatedBoard(14, true);
for (const scenario of [
  { name: "long menu at the left edge", roles: 7, presets: 12, column: 0, split: false, longNames: false },
  { name: "long role names at the right edge", roles: 15, presets: 24, column: 6, split: false, longNames: true },
  { name: "short menu above a bottom card", roles: 1, presets: 1, column: 2, split: false, longNames: false },
  { name: "long menu in a narrow split pane", roles: 7, presets: 12, column: 5, split: true, longNames: false },
]) {
test.describe(scenario.name, () => {
test.use({ seedOptions: {
  singleTab: { presetId: "board", name: "Board" },
  presetList: Array.from({ length: scenario.presets }, (_, i) => ({ id: `preset-${i}`, name: `Preset ${i}`, icon: "$", color: "", command: "$SHELL" })),
  ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
} });

test("a full board keeps assignment choices inside the viewport and selectable after resize", async ({ seeded }, testInfo) => {
  const projectPath = join(seeded.ayaHome, "projects/e2e-proj.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  const roleName = (index: number) => `Role ${index}${scenario.longNames ? " — reviewing implementation, tests and the complete delivery workflow" : ""}`;
  project.tabs.push(...Array.from({ length: scenario.roles }, (_, i) => ({ id: `role-${i + 1}`, name: roleName(i + 1), presetId: "preset-0" })));
  if (scenario.split) project.splitLayout = { rows: 1, cols: 2, rowFr: [1], colFr: [1, 1], cells: [project.tabs[0].id, "role-1"], activeCell: 0 };
  writeFileSync(projectPath, JSON.stringify(project));
  const app = await launchApp(seeded);
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1000, height: 550 });
    const targetId = `t-${scenario.column * 14 + 14}`;
    const card = window.getByTestId(`kanban-card-${targetId}`);
    await card.scrollIntoViewIfNeeded();
    const cardBounds = (await card.boundingBox())!;
    expect(cardBounds.y + cardBounds.height).toBeGreaterThan(400);
    await card.getByRole("button", { name: /^(Unassigned|@)/ }).click();
    const menu = window.locator(".aya-kanban-popover");
    await expect(menu).toBeVisible();
    const insideViewport = () => menu.evaluate(element => {
      const r = element.getBoundingClientRect();
      return r.top >= 7 && r.left >= 7 && r.bottom <= window.innerHeight - 7 && r.right <= window.innerWidth - 7;
    });
    await expect.poll(insideViewport, { message: "the complete assignment menu must fit within the viewport" }).toBe(true);
    expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(scenario.roles > 1);
    await window.setViewportSize({ width: 750, height: 380 });
    await expect.poll(insideViewport).toBe(true);
    await menu.getByRole("menuitem", { name: /Delete card/ }).focus();
    await expect(menu.getByRole("menuitem", { name: /Delete card/ })).toBeInViewport({ ratio: 1 });
    const role = menu.getByRole("menuitem", { name: `● ${roleName(scenario.roles)}`, exact: true });
    await role.scrollIntoViewIfNeeded();
    await expect(role).toBeInViewport({ ratio: 1 });
    await window.screenshot({ path: testInfo.outputPath("bottom-card-assignment-menu.png") });
    await role.click();
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => {
      const current = await window.evaluate(() => window.aya.getBoard("e2e-proj"));
      return current.cards.find(card => card.id === targetId)?.claim?.paneId;
    }).toBe(`role-${scenario.roles}`);
    const current = await window.evaluate(() => window.aya.getBoard("e2e-proj"));
    expect(current.cards.filter(card => card.id !== targetId)).toEqual(board.cards.filter(card => card.id !== targetId));
    await expect(window.locator(".aya-kanban-error")).toHaveCount(0);
  } finally { await closeAndWait(app); }
});
});
}

test.describe("GUI presets without board-task startup support", () => {
  test.use({ seedOptions: {
    singleTab: { presetId: "board", name: "Board" },
    presetList: [
      { id: "gui", name: "Unsupported GUI start", icon: "◆", color: "", command: "codex", agent: "codex", interfaceMode: "gui" },
      { id: "shell", name: "Supported terminal", icon: "$", color: "", command: "$SHELL" },
    ],
    ayaHomeFiles: { "boards/e2e-proj.json": JSON.stringify(board) },
  } });
  test("does not offer an action that would leave a phantom reservation", async ({ window }) => {
    await window.getByTestId("kanban-card-t-1").getByRole("button", { name: /Terminal/ }).click();
    await expect(window.getByRole("menuitem", { name: /Unsupported GUI start/ })).toHaveCount(0);
    await expect(window.getByRole("menuitem", { name: /Supported terminal/ })).toHaveCount(1);
    const snapshot = await window.evaluate(() => window.aya.getBoard("e2e-proj"));
    expect(snapshot.cards[0].claim).toBeUndefined();
  });
});
