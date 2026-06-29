import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { ElectronApplication, Page } from "@playwright/test";

// In the experimental "Projects on left" layout, the recent-projects dropdown
// (the folder_open button in the rail header) is `.aya-recent-menu`, which is
// width:280px and `right:0`. The rail is only ~220px wide at the LEFT edge of
// the window, so a right-anchored 280px menu extends past the left viewport
// edge and is clipped by `.aya-main { overflow:hidden }`. It must open within
// the window instead.

async function enableProjectsLeftLayout(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings
    .locator('.aya-settings-segmented[aria-label="Window layout"] button', { hasText: "Projects on left" })
    .click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
}

test.use({
  seedOptions: {
    split: false,
    closedProjects: ["Old Client", "Sandbox", "Archived Repo"],
  },
});

test("the recent-projects menu opens fully inside the window (Projects-on-left)", async ({
  window,
  app,
}) => {
  await enableProjectsLeftLayout(window, app);

  await window.locator(".aya-projectrail .aya-recent-projects button").click();
  const menu = window.locator(".aya-projectrail .aya-recent-menu");
  await expect(menu).toBeVisible();
  // the closed projects are actually listed
  await expect(menu.locator(".aya-recent-menu-item")).toHaveCount(3);

  const fit = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  });

  // The whole menu box must sit within the viewport - not spill off the left
  // edge (where .aya-main's overflow:hidden clips it).
  expect(fit.left, `menu left edge off-screen: ${JSON.stringify(fit)}`).toBeGreaterThanOrEqual(0);
  expect(fit.right, `menu right edge off-screen: ${JSON.stringify(fit)}`).toBeLessThanOrEqual(fit.vw);
  expect(fit.bottom).toBeLessThanOrEqual(fit.vh);
});
