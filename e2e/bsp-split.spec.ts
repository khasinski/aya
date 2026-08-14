import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { Page } from "@playwright/test";

// BSP pane layout. The old model was a uniform rows x cols grid, so splitting
// one pane inserted a whole track and resized every pane sharing it. These
// tests pin the behaviour that replaced it — and the migration that gets an
// existing (grid-shaped) project there.

const pane = (window: Page, name: string) =>
  window.locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]`);

async function boxOf(window: Page, name: string) {
  const box = await pane(window, name).boundingBox();
  if (!box) throw new Error(`pane ${name} has no box`);
  return box;
}

test("a project stored in the legacy grid format opens with its layout intact", async ({
  window,
}) => {
  // The seed writes the pre-tree `splitLayout`; both panes must still be side
  // by side after migration, not stacked or collapsed.
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  const left = await boxOf(window, "shell 1");
  const right = await boxOf(window, "shell 2");
  expect(left.width).toBeGreaterThan(0);
  expect(right.x).toBeGreaterThan(left.x);
  // Same row: a 1x2 grid is horizontal.
  expect(Math.abs(right.y - left.y)).toBeLessThan(4);
});

test("splitting one pane leaves its neighbour exactly where it was", async ({
  window,
  app,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  const before = await boxOf(window, "shell 2");

  // Focus the LEFT pane and split it below. In the old grid this inserted a
  // row and shrank shell 2 to half height; with a tree only shell 1 divides.
  await fireShortcut(app, "focus-pane-left");
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 1"]'),
  ).toBeVisible();
  await fireShortcut(app, "split-pane-below");
  await expect(window.locator(".aya-pane-empty")).toBeVisible();

  const after = await boxOf(window, "shell 2");
  expect(Math.abs(after.x - before.x)).toBeLessThan(4);
  expect(Math.abs(after.y - before.y)).toBeLessThan(4);
  expect(Math.abs(after.width - before.width)).toBeLessThan(4);
  expect(Math.abs(after.height - before.height)).toBeLessThan(4);
});

test("a nested split divides only its own half", async ({ window, app }) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  const leftBefore = await boxOf(window, "shell 1");

  await fireShortcut(app, "focus-pane-right");
  await expect(
    window.locator('.aya-pane--active-split[data-terminal-name="shell 2"]'),
  ).toBeVisible();
  await fireShortcut(app, "split-pane-below");

  const rightAfter = await boxOf(window, "shell 2");
  const leftAfter = await boxOf(window, "shell 1");
  // The right pane lost half its height...
  expect(rightAfter.height).toBeLessThan(leftBefore.height * 0.75);
  // ...while the left one kept all of it.
  expect(Math.abs(leftAfter.height - leftBefore.height)).toBeLessThan(4);
});

test("panes still tile the container with no gap or overlap after a split", async ({
  window,
  app,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  await fireShortcut(app, "split-pane-below");
  await expect(window.locator(".aya-pane-empty")).toBeVisible();

  const container = await window.locator(".aya-panes--split").boundingBox();
  const boxes = await window
    .locator(".aya-panes--split > .aya-pane:visible")
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
  expect(boxes.length).toBeGreaterThanOrEqual(3);

  const area = boxes.reduce((sum, b) => sum + b.w * b.h, 0);
  const containerArea = (container?.width ?? 0) * (container?.height ?? 0);
  // Panes fill the container (a few px of divider slack).
  expect(Math.abs(area - containerArea) / containerArea).toBeLessThan(0.05);

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlaps =
        a.x < b.x + b.w - 2 &&
        b.x < a.x + a.w - 2 &&
        a.y < b.y + b.h - 2 &&
        b.y < a.y + a.h - 2;
      expect(overlaps, `panes ${i} and ${j} overlap`).toBe(false);
    }
  }
});

test("the layout survives a reload as a tree (migration is written back)", async ({
  window,
  app,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  await fireShortcut(app, "focus-pane-right");
  await fireShortcut(app, "split-pane-below");
  await expect(window.locator(".aya-pane-empty")).toBeVisible();

  // The nested layout must be persisted in the new format, not the old grid.
  const config = await window.evaluate(async () => {
    const projects = await window.aya.listProjects();
    return projects.map((p) => ({
      hasTree: !!p.splitTree,
      hasLegacy: !!p.splitLayout,
    }));
  });
  expect(config.some((c) => c.hasTree)).toBe(true);
  expect(config.every((c) => !c.hasLegacy)).toBe(true);
});

test("reshaping the layout does not remount a terminal", async ({ window, app }) => {
  // The reason panes are positioned rather than nested: nesting the DOM to
  // match the tree would move each TerminalView in the React tree on every
  // reshape, remounting it — a visible flash plus a scrollback replay.
  // Tag the live DOM node, reshape twice, and check the SAME node survives.
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
  await window.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="terminal-pane"][data-terminal-name="shell 2"]',
    );
    (el as HTMLElement & { __ayaProbe?: string }).__ayaProbe = "kept";
  });

  await fireShortcut(app, "focus-pane-left");
  await fireShortcut(app, "split-pane-below");
  await expect(window.locator(".aya-pane-empty")).toBeVisible();
  await fireShortcut(app, "focus-pane-right");

  const survived = await window.evaluate(() => {
    const el = document.querySelector(
      '[data-testid="terminal-pane"][data-terminal-name="shell 2"]',
    );
    return (el as HTMLElement & { __ayaProbe?: string })?.__ayaProbe ?? null;
  });
  expect(survived, "the pane's DOM node was replaced — it remounted").toBe("kept");
});
