import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Reproduces the reported "focus doesn't switch / have to click twice" glitch.
// Aya hides inactive terminals with display:none and never re-focuses the
// terminal that becomes visible, so switching tabs via the sidebar leaves the
// keyboard focus behind. This single-terminal (no split) layout is where it
// bites: only the active tab is visible, so a tab switch is a real show/hide.
test.use({ seedOptions: { split: false } });

function sidebarRow(window: Page, name: string) {
  return window.locator(".aya-sidebar-row", {
    has: window.locator(".aya-sidebar-name", { hasText: new RegExp(`^${name}$`) }),
  });
}

function visiblePaneTitle(window: Page) {
  return window.evaluate(() => {
    const pane = Array.from(document.querySelectorAll(".aya-pane")).find(
      (p) => getComputedStyle(p as HTMLElement).display !== "none",
    );
    return pane?.querySelector(".aya-pane-header-title")?.textContent ?? null;
  });
}

test("switching terminals via the sidebar moves keyboard focus to the new terminal", async ({
  window,
}) => {
  // Start with focus established inside shell 1.
  await window.locator(".aya-pane:visible .aya-xterm-host").click();
  await expect.poll(() => visiblePaneTitle(window)).toBe("shell 1");

  // One click on shell 2's sidebar row.
  await sidebarRow(window, "shell 2").click();
  await expect.poll(() => visiblePaneTitle(window)).toBe("shell 2");

  // Keyboard focus must now be inside shell 2's terminal — not left on shell 1,
  // the sidebar row, or the body. If it isn't, the user has to click the
  // terminal a second time before typing reaches it.
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const pane = Array.from(document.querySelectorAll(".aya-pane")).find(
            (p) => getComputedStyle(p as HTMLElement).display !== "none",
          );
          const active = document.activeElement;
          return !!(
            pane &&
            active &&
            pane.contains(active) &&
            active.tagName.toLowerCase() === "textarea"
          );
        }),
      { message: "focus should land inside the newly-shown terminal" },
    )
    .toBe(true);
});
