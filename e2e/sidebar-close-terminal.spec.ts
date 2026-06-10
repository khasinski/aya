import { test, expect } from "./fixtures";

// Closing a terminal from the sidebar context menu mutates both the tab list and
// the active-selection state. The dangling-active-pointer class of bug (see #18)
// is exactly what these guard: closing must never leave the active pane pointing
// at a terminal that no longer exists. Placement = sidebar close behaviour; each
// test names the one invariant it checks.

test.use({ seedOptions: { split: false } }); // single-view, two terminals, one active

async function closeViaMenu(window: import("@playwright/test").Page, name: string) {
  await window
    .locator(".aya-sidebar-row", { hasText: name })
    .click({ button: "right" });
  await window
    .locator(".aya-context-menu-item", { hasText: "Close terminal" })
    .click();
}

// Invariant: closing the CURRENTLY ACTIVE terminal hands active state to the
// surviving terminal (not a dangling id / blank pane).
test("closing the active terminal via the sidebar menu activates the surviving terminal", async ({
  window,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);

  await closeViaMenu(window, "shell 1");

  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 1" }),
  ).toHaveCount(0);
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 2/);
  await expect(
    window.locator(".aya-pane-header-title").filter({ hasText: /shell 2/ }),
  ).toBeVisible();
});

// Invariant: closing a NON-active terminal removes only that row and leaves the
// active selection untouched.
test("closing a non-active terminal via the sidebar menu leaves the active one untouched", async ({
  window,
}) => {
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);

  await closeViaMenu(window, "shell 2");

  await expect(
    window.locator(".aya-sidebar-row", { hasText: "shell 2" }),
  ).toHaveCount(0);
  await expect(window.locator(".aya-sidebar-row--active")).toHaveText(/shell 1/);
});
