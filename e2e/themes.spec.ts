import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Settings > Themes: deleting the ACTIVE theme must fall back gracefully to a
// valid remaining theme (not an empty/broken active id).

test("deleting the active theme falls back to a valid theme and persists", async ({
  window,
  app,
  seeded,
}) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Themes" }).click();

  const rows = settings.locator(".aya-theme-row");
  await expect(rows).toHaveCount(5); // 5 seeded built-ins

  // The active theme row (its radio is checked); capture its name.
  const activeRow = rows.filter({ has: window.locator("input[type=radio]:checked") });
  const deletedName = (await activeRow.locator(".aya-theme-name").textContent())?.trim();
  expect(deletedName).toBeTruthy();

  // Accept the native confirm() before clicking delete.
  window.once("dialog", (d) => d.accept());
  await activeRow.locator(".aya-settings-row-close").click();

  // Row gone, and exactly one (different) theme is now active - not a broken/empty state.
  await expect(rows).toHaveCount(4);
  await expect(settings.locator(".aya-theme-row input[type=radio]:checked")).toHaveCount(1);

  // Save and assert persisted activeId is a valid remaining theme, not the deleted one.
  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();
  await expect(settings).toBeHidden();
  await expect
    .poll(() => {
      try {
        const cfg = JSON.parse(readFileSync(join(seeded.ayaHome, "themes.json"), "utf8"));
        const ids = (cfg.themes as Array<{ id: string; name: string }>).map((t) => t.name);
        return { activeId: cfg.activeId as string, count: cfg.themes.length, hasDeleted: ids.includes(deletedName!) };
      } catch {
        return null;
      }
    })
    .toEqual({ activeId: expect.stringMatching(/.+/), count: 4, hasDeleted: false });
});
