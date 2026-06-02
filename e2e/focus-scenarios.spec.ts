import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Maps the breadth of the focus glitch beyond the sidebar tab switch. Each test
// asserts the behavior a user expects ("I can type without an extra click"); a
// red test = a reproduced bug. Uses the default 1x2 split seed.

// Aya intercepts app shortcuts via webContents before-input-event, which
// Playwright's synthetic keyboard does NOT trigger. So fire the shortcut the
// way main.ts ultimately does: send the "shortcut" action straight to the
// renderer from the main process. This tests the App's shortcut HANDLING (and
// whether focus follows), not the OS keybinding.
import type { ElectronApplication } from "@playwright/test";
async function fireShortcut(app: ElectronApplication, action: string) {
  await app.evaluate(({ BrowserWindow }, act) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send("shortcut", act);
  }, action);
}

function focusInfo(window: Page) {
  return window.evaluate(() => {
    const panes = Array.from(document.querySelectorAll(".aya-pane"));
    const active = document.activeElement;
    const owner = panes.find((p) => active && p.contains(active));
    return {
      tag: active ? active.tagName.toLowerCase() : null,
      inAnyTerminal: !!owner && active!.tagName.toLowerCase() === "textarea",
      ownerTitle: owner?.querySelector(".aya-pane-header-title")?.textContent ?? null,
      activeCellTitle:
        document
          .querySelector(".aya-pane--active-split .aya-pane-header-title")
          ?.textContent ?? null,
    };
  });
}

test("the active terminal is focused on launch (no click needed to type)", async ({
  window,
}) => {
  await expect(window.locator(".aya-pane")).toHaveCount(2);
  await expect
    .poll(async () => (await focusInfo(window)).inAnyTerminal, {
      message: "a terminal should hold focus right after launch",
    })
    .toBe(true);
});

test("focus-pane-right shortcut moves focus to the next split pane", async ({
  window,
  app,
}) => {
  // Focus pane 1 first.
  await window.locator(".aya-pane").first().locator(".aya-xterm-host").click();
  await expect(window.locator(".aya-pane--active-split .aya-pane-header-title")).toHaveText(
    "shell 1",
  );

  await fireShortcut(app, "focus-pane-right");

  // Active cell should move to pane 2 AND keyboard focus should follow it.
  await expect(window.locator(".aya-pane--active-split .aya-pane-header-title")).toHaveText(
    "shell 2",
  );
  await expect
    .poll(
      async () => {
        const f = await focusInfo(window);
        return f.inAnyTerminal && f.ownerTitle === "shell 2";
      },
      { message: "focus should follow the active cell" },
    )
    .toBe(true);
});

test("closing Settings returns focus to the terminal", async ({ window, app }) => {
  await window.locator(".aya-pane").first().locator(".aya-xterm-host").click();

  // Open Settings via the shortcut action, then close with Escape (a normal
  // page keydown listener, which Playwright's keyboard does reach).
  await fireShortcut(app, "open-settings");
  await expect(window.locator(".aya-modal--settings")).toBeVisible();
  // Close via the Cancel button (Escape is swallowed by the focused xterm).
  await window.locator(".aya-modal-btn", { hasText: "Cancel" }).click();
  await expect(window.locator(".aya-modal--settings")).toHaveCount(0);

  await expect
    .poll(async () => (await focusInfo(window)).inAnyTerminal, {
      message: "focus should return to the terminal after the modal closes",
    })
    .toBe(true);
});
