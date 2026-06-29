import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { ElectronApplication, Page } from "@playwright/test";

// The "+ New terminal" launcher must spawn a terminal in the experimental
// "Projects on left" window layout, in BOTH the split and single-view (no
// split) seeds. There the launcher is a top-tab "+" button
// (ProjectsLeftLayout's `aya-tab-new`) that opens a `aya-recent-menu` dropdown.
//
// The dropdown lives inside the terminal tab strip `.aya-tabs`
// (overflow-y:hidden). It must be position:fixed so it escapes that clip;
// otherwise the preset rows are clipped away and a real user's click lands on
// the terminal pane behind them (only Cmd/Ctrl+T, which bypasses the menu,
// still works). A plain Playwright `.click()` would mask the bug by scrolling
// the overflow:hidden strip, so we assert the way a user's cursor sees it:
// the preset row must be the topmost element where it is drawn.

async function enableProjectsLeftLayout(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings
    .locator('.aya-settings-segmented[aria-label="Window layout"] button', {
      hasText: "Projects on left",
    })
    .click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
}

/** Open the "+" menu and report whether the first preset row is genuinely
 *  reachable: the element under the cursor at the row's drawn centre is the row
 *  itself (or a descendant of the dropdown), not whatever sits behind it. */
async function probeLauncherReachable(window: Page) {
  await window.locator(".aya-termtab-launcher .aya-tab-new").click();
  await expect(window.locator(".aya-termtab-launcher .aya-recent-menu")).toBeVisible();
  return await window.evaluate(() => {
    const row = document.querySelector(
      ".aya-termtab-launcher .aya-recent-menu .aya-recent-menu-item",
    ) as HTMLElement | null;
    if (!row) return { menuPresent: false, rowReachable: false, topElement: "(no row)" };
    const r = row.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null;
    const menu = row.closest(".aya-recent-menu");
    return {
      menuPresent: true,
      rowReachable: !!top && !!menu && menu.contains(top),
      topElement: top ? `${top.tagName.toLowerCase()}.${top.className}` : "null",
    };
  });
}

/** Shared body: enable the layout, then prove the "+" launcher reaches and
 *  launches a preset. The seed ships two terminals; we add a third via
 *  Cmd/Ctrl+T first so the strip mirrors a real session. */
async function expectLauncherSpawnsTerminal(window: Page, app: ElectronApplication) {
  await enableProjectsLeftLayout(window, app);
  await fireShortcut(app, "new-shell");
  await expect(window.getByTestId("termtab")).toHaveCount(3);

  const probe = await probeLauncherReachable(window);
  expect(probe.menuPresent).toBe(true);
  expect(
    probe.rowReachable,
    `preset row is not hit-testable; topmost element at its centre is "${probe.topElement}" (menu clipped by .aya-tabs overflow?)`,
  ).toBe(true);

  await window
    .locator(".aya-termtab-launcher .aya-recent-menu .aya-recent-menu-item", { hasText: "Shell" })
    .click();
  await expect(window.getByTestId("termtab")).toHaveCount(4);
}

test.describe("split seed (1x2)", () => {
  // Default seed: a 1x2 split, both panes visible.
  test("the + launcher spawns a terminal (Projects-on-left, split)", async ({ window, app }) => {
    await expectLauncherSpawnsTerminal(window, app);
  });
});

test.describe("no-split seed (single view)", () => {
  test.use({ seedOptions: { split: false } });
  test("the + launcher spawns a terminal (Projects-on-left, no split)", async ({ window, app }) => {
    await expectLauncherSpawnsTerminal(window, app);
  });
});

test.describe("selecting a specific preset", () => {
  test.use({
    seedOptions: {
      presetList: [
        { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
        { id: "claude", name: "Claude Code", icon: "✻", color: "#d97757", command: "$SHELL" },
        { id: "codex", name: "Codex", icon: "◆", color: "#10a37f", command: "$SHELL" },
      ],
    },
  });

  // Picking a preset from the "+" menu must open a new tab for THAT preset -
  // not just "a tab". Verifies name, icon, active state, and that the menu closes.
  test("picking a preset opens a correct new tab for it", async ({ window, app }) => {
    await enableProjectsLeftLayout(window, app);
    const before = await window.getByTestId("termtab").count();

    await window.locator(".aya-termtab-launcher .aya-tab-new").click();
    await expect(window.locator(".aya-termtab-launcher .aya-recent-menu")).toBeVisible();
    await window
      .locator(".aya-termtab-launcher .aya-recent-menu .aya-recent-menu-item", { hasText: "Claude Code" })
      .click();

    await expect(window.getByTestId("termtab")).toHaveCount(before + 1);
    const newTab = window.locator('[data-testid="termtab"][data-terminal-name="Claude Code"]');
    await expect(newTab).toHaveCount(1);
    await expect(newTab.locator(".aya-sidebar-icon")).toHaveText("✻"); // Claude preset icon
    await expect(newTab).toHaveClass(/aya-tab--active/); // becomes the active tab
    await expect(window.locator(".aya-termtab-launcher .aya-recent-menu")).toBeHidden(); // menu closed
  });
});

test.describe("scrollable launcher menu", () => {
  // Enough presets that the dropdown exceeds its max-height and scrolls.
  test.use({
    seedOptions: {
      presetList: Array.from({ length: 16 }, (_, i) => ({
        id: `p${i}`,
        name: `Preset ${i}`,
        icon: "$",
        color: "",
        command: "$SHELL",
      })),
    },
  });

  // The dropdown closes when the tab strip scrolls (the "+" moves), but NOT when
  // the user scrolls the preset list itself — otherwise a long list is unusable.
  test("scrolling the preset list does not dismiss the launcher menu", async ({ window, app }) => {
    await enableProjectsLeftLayout(window, app);
    await window.locator(".aya-termtab-launcher .aya-tab-new").click();
    const menu = window.locator(".aya-termtab-launcher .aya-recent-menu");
    await expect(menu).toBeVisible();

    await menu.hover();
    await window.mouse.wheel(0, 200);
    await window.waitForTimeout(150);

    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
