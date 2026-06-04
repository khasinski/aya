import { test, expect } from "./fixtures";

// The snippet drawer end to end: it opens from the pane header, shows the
// seeded default snippet with its full text, and collapses after a send so the
// terminal result stays visible.

test("snippet drawer opens, shows the seeded default, and collapses after sending", async ({
  window,
}) => {
  // The fresh AYA_HOME has no snippets file, so the app seeds DEFAULT_SNIPPETS
  // on boot. Open the first pane's drawer.
  await window.getByTestId("snippet-toggle").first().click();

  const drawer = window.getByTestId("snippet-drawer").first();
  await expect(drawer).toBeVisible();

  // Seeded default renders with its name AND its full text (the point of the
  // drawer: verify a prompt before sending).
  await expect(
    drawer.getByTestId("snippet-name").filter({ hasText: "magic numbers audit" }),
  ).toBeVisible();
  await expect(drawer.getByTestId("snippet-text").first()).toContainText(
    "Run a full magic-numbers audit",
  );

  // Sending collapses the drawer (no open drawer remains anywhere).
  await drawer.getByTestId("snippet-item").first().click();
  await expect(window.locator(".aya-snippetbar--open")).toHaveCount(0);
});

test("closed snippet drawer is inert (cannot be tab-focused or clicked)", async ({
  window,
}) => {
  // Regression guard for the F14 ghost-drawer fix: while closed, the drawer's
  // buttons must be removed from the a11y/tab tree (inert), so they can't steal
  // focus or clicks over the status bar.
  const closedDrawer = window.getByTestId("snippet-drawer").first();
  await expect(closedDrawer).not.toHaveClass(/aya-snippetbar--open/);
  await expect(closedDrawer).toHaveAttribute("inert", "");
});

test("snippet drawer settings button opens the Snippets settings tab", async ({
  window,
}) => {
  await window.getByTestId("snippet-toggle").first().click();

  const drawer = window.getByTestId("snippet-drawer").first();
  await drawer.getByTestId("snippet-settings-button").click();

  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await expect(
    settings.getByTestId("settings-tab").filter({ hasText: "Snippets" }),
  ).toBeVisible();
  await expect(settings.locator(".aya-modal-title", { hasText: "Snippets" })).toBeVisible();
});
