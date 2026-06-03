import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Maps the breadth of the focus glitch beyond the sidebar tab switch. Each test
// asserts the behavior a user expects ("I can type without an extra click"); a
// red test = a reproduced bug. Uses the default 1x2 split seed.

import { fireShortcut } from "./helpers/shortcut";

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

test("opening the recent-projects menu keeps terminal focus", async ({
  window,
}) => {
  // Inline top-bar dropdowns (recent projects, usage chips) must not steal
  // keyboard focus the way a modal does — peeking shouldn't force a re-click.
  await window.locator(".aya-pane").first().locator(".aya-xterm-host").click();
  await expect.poll(async () => (await focusInfo(window)).inAnyTerminal).toBe(true);

  await window.getByRole("button", { name: "Recent projects" }).click();
  await expect(window.locator(".aya-recent-menu")).toBeVisible();
  expect((await focusInfo(window)).inAnyTerminal).toBe(true);
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

test("closing Search returns focus to the terminal", async ({ window, app }) => {
  await window.locator(".aya-pane").first().locator(".aya-xterm-host").click();

  await fireShortcut(app, "search");
  await expect(window.locator(".aya-modal--search")).toBeVisible();
  // The search input holds focus, so Escape reaches the modal (not xterm).
  await window.keyboard.press("Escape");
  await expect(window.locator(".aya-modal--search")).toHaveCount(0);

  await expect
    .poll(async () => (await focusInfo(window)).inAnyTerminal, {
      message: "focus should return to the terminal after Search closes",
    })
    .toBe(true);
});

test("the find bar holds focus while open and returns it to the terminal on close", async ({
  window,
  app,
}) => {
  await window.locator(".aya-pane").first().locator(".aya-xterm-host").click();

  // Open the in-pane find bar; its input — not the terminal — must take focus.
  await fireShortcut(app, "find-in-pane");
  await expect(window.locator(".aya-findbar-input")).toBeFocused();

  // Close the find bar (the ✕ button); focus must return to the terminal.
  await window.locator('.aya-findbar-btn[title^="Close"]').click();
  await expect(window.locator(".aya-findbar")).toHaveCount(0);
  await expect
    .poll(async () => (await focusInfo(window)).inAnyTerminal, {
      message: "focus should return to the terminal after the find bar closes",
    })
    .toBe(true);
});
