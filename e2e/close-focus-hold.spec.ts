import { test, expect } from "./fixtures";
import type { ElectronApplication, Page } from "@playwright/test";
import { fireShortcut } from "./helpers/shortcut";
import { sidebarRow } from "./helpers/sidebar";
import { visiblePane } from "./helpers/terminal";

// Live finding F5: closing the pane the user was typing in moved keyboard focus
// to a neighbour, so the rest of the message landed in another agent's composer.
// After a close the neighbour may become the selected pane, but keystrokes must
// not reach it until the user picks it (click, sidebar, navigation shortcut).
// Single view is where it leaked; a split leaves an empty active cell and is a guard.

// Past TerminalView's focus effect (now, next frame, FOCUS_RETRY_DELAY_MS = 60) with margin, so a late focus
// cannot hide the leak.
const PAST_FOCUS_RETRIES_MS = 300;

const bufferOf = (window: Page, id: string) =>
  window.evaluate((tid) => window.aya.ptyBuffer(tid), id);

async function readyIds(window: Page) {
  const ids: Record<string, string> = {};
  for (const name of ["shell 1", "shell 2"]) {
    const id = await window
      .locator(`[data-testid="terminal-pane"][data-terminal-name="${name}"]`)
      .getAttribute("data-terminal-id");
    expect(id).toBeTruthy();
    ids[name] = id!;
    await expect.poll(() => bufferOf(window, id!).then((b) => b.length)).toBeGreaterThan(0);
  }
  return ids;
}

for (const split of [true, false]) {
  test.describe(split ? "split view" : "single view", () => {
    test.use({ seedOptions: { split } });

    test("keystrokes typed across a close do not reach the neighbour pane", async ({
      window,
      app,
    }) => {
      await closeThenPick(window, app, () => visiblePane(window, "shell 2").locator(".aya-xterm-host").click());
    });
  });
}

/** Close shell 1 mid-typing, type more, let the user pick shell 2 by `pick`: only what follows the pick lands there. */
async function closeThenPick(window: Page, app: ElectronApplication, pick: () => Promise<unknown>) {
  const ids = await readyIds(window);
  await visiblePane(window, "shell 1").locator(".aya-xterm-host").click();
  await window.keyboard.type("echo head");

  await fireShortcut(app, "close-tab");
  await expect(window.locator('[data-testid="terminal-pane"][data-terminal-name="shell 1"]')).toHaveCount(0);
  await expect(visiblePane(window, "shell 2")).toBeVisible();
  await window.waitForTimeout(PAST_FOCUS_RETRIES_MS);
  await window.keyboard.type("zqtailmark");

  // The user picks the pane; typing from then on is theirs to send there.
  await pick();
  await expect(visiblePane(window, "shell 2")).toBeVisible();
  await window.keyboard.type("zqpickedmark");
  await expect.poll(() => bufferOf(window, ids["shell 2"])).toContain("zqpickedmark");
  expect(await bufferOf(window, ids["shell 2"])).not.toContain("zqtailmark");
}

// Every way to pick ends the hold, also when it lands on the held pane itself (one tab left, no split to move in).
test.describe("single view, each pick ends the hold", () => {
  test.use({ seedOptions: { split: false, secondProject: true } });
  const PICKS: [string, (window: Page, app: ElectronApplication) => Promise<unknown>][] = [
    ["sidebar row", (window) => sidebarRow(window, "shell 2").click()],
    ["next-tab", (_, app) => fireShortcut(app, "next-tab")],
    ["prev-tab", (_, app) => fireShortcut(app, "prev-tab")],
    ["focus-pane-right", (_, app) => fireShortcut(app, "focus-pane-right")],
    [
      "another project and back",
      async (window, app) => {
        await fireShortcut(app, "project-2");
        await expect(visiblePane(window, "shell 2")).toHaveCount(0);
        await fireShortcut(app, "project-1");
      },
    ],
  ];
  for (const [label, pick] of PICKS) {
    test(`${label}`, async ({ window, app }) => {
      await closeThenPick(window, app, () => pick(window, app));
    });
  }
});

// "Projects on left" has no split: a click on the pane must end the hold there too.
test("projects on left: a click on the pane ends the hold", async ({ window, app }) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await settings.locator('.aya-settings-segmented[aria-label="Window layout"] button', { hasText: "Projects on left" }).click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
  await closeThenPick(window, app, () => visiblePane(window, "shell 2").locator(".aya-xterm-host").click());
});
