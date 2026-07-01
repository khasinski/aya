import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { enableProjectsLeftLayout } from "./helpers/layout";

// Experimental "Projects on left" layout: when a project has NO terminals, the
// "+ New terminal" launcher sits at the far LEFT of the tab strip. Its dropdown
// is a position:fixed menu anchored to the button's rect; if it always opens
// leftward (right-anchored) it runs OFF-SCREEN to the left here. It must instead
// stay fully on-screen (open rightward when the button is near the left edge) -
// the same class of off-screen-menu bug fixed earlier for the recent-projects
// dropdown.

test.use({ seedOptions: { split: false } });

test("the New-terminal launcher menu stays on-screen with no tabs open", async ({
  window,
  app,
}) => {
  await enableProjectsLeftLayout(window, app);

  // Close every terminal so the "+" launcher is alone at the far left.
  await fireShortcut(app, "close-tab");
  await fireShortcut(app, "close-tab");
  await expect(window.getByTestId("termtab")).toHaveCount(0);

  const plus = window.locator('.aya-termtab-launcher [aria-label="New terminal"]');
  await expect(plus).toBeVisible();
  await plus.click();

  const menu = window.locator(".aya-termtab-launcher .aya-recent-menu");
  await expect(menu).toBeVisible();

  // The dropdown must be fully within the viewport - not clipped off the left.
  const box = await menu.boundingBox();
  const innerWidth = await window.evaluate(() => window.innerWidth);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(innerWidth);

  // And it's actually hit-testable at its own center (not just positioned there).
  const hit = await window.evaluate(() => {
    const m = document.querySelector(".aya-termtab-launcher .aya-recent-menu");
    if (!m) return false;
    const r = m.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!el && m.contains(el);
  });
  expect(hit).toBe(true);
});
