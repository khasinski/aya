import { test, expect } from "./fixtures";

// The snippet drawer end to end: it opens from the pane header, shows the
// seeded default snippet with its full text, and collapses after a send so the
// terminal result stays visible.

test("snippet drawer opens, shows the seeded default, and collapses after sending", async ({
  window,
}) => {
  // The fresh AYA_HOME has no snippets file, so the app seeds DEFAULT_SNIPPETS
  // on boot. Open the first pane's drawer.
  await window.locator(".aya-pane-snippettoggle").first().click();

  const drawer = window.locator(".aya-snippetbar--open").first();
  await expect(drawer).toBeVisible();

  // Seeded default renders with its name AND its full text (the point of the
  // drawer: verify a prompt before sending).
  await expect(
    drawer.locator(".aya-snippet-name", { hasText: "magic numbers audit" }),
  ).toBeVisible();
  await expect(drawer.locator(".aya-snippet-text").first()).toContainText(
    "Run a full magic-numbers audit",
  );

  // Sending collapses the drawer (no open drawer remains anywhere).
  await drawer.locator(".aya-snippet").first().click();
  await expect(window.locator(".aya-snippetbar--open")).toHaveCount(0);
});

test("closed snippet drawer is inert (cannot be tab-focused or clicked)", async ({
  window,
}) => {
  // Regression guard for the F14 ghost-drawer fix: while closed, the drawer's
  // buttons must be removed from the a11y/tab tree (inert), so they can't steal
  // focus or clicks over the status bar.
  const closedDrawer = window.locator(".aya-snippetbar").first();
  await expect(closedDrawer).not.toHaveClass(/aya-snippetbar--open/);
  await expect(closedDrawer).toHaveAttribute("inert", "");
});
