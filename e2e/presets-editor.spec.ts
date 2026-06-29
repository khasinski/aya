import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// Settings > Presets editor: add a custom preset (-> appears as a sidebar
// launcher + persists), and validation blocks an incomplete preset.

async function openPresetsTab(window: Page, app: import("@playwright/test").ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();
  return settings;
}

// Command input is identified by its placeholder; Name by "Display name".
const commandInput = (s: Page | ReturnType<Page["locator"]>) =>
  (s as ReturnType<Page["locator"]>).locator('.aya-modal-input[placeholder*="$SHELL"]');
const nameInput = (s: ReturnType<Page["locator"]>) =>
  s.locator('.aya-modal-input[placeholder="Display name"]');

test("adding a custom preset surfaces it as a launcher and persists it", async ({
  window,
  app,
  seeded,
}) => {
  const settings = await openPresetsTab(window, app);
  await settings.locator(".aya-settings-add", { hasText: "Add custom" }).click();

  await commandInput(settings).fill("$SHELL");
  await nameInput(settings).fill("MyShell");
  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();
  await expect(settings).toBeHidden();

  // New preset shows up as a sidebar launcher button...
  await expect(window.locator(".aya-launcher-btn", { hasText: "MyShell" })).toBeVisible();
  // ...and is written to presets.json.
  await expect
    .poll(() => {
      try {
        const cfg = JSON.parse(readFileSync(join(seeded.ayaHome, "presets.json"), "utf8"));
        return (cfg.presets as Array<{ name: string }>).map((p) => p.name);
      } catch {
        return [];
      }
    })
    .toContain("MyShell");
});

test("a preset with no command is rejected by validation (not saved)", async ({
  window,
  app,
  seeded,
}) => {
  const settings = await openPresetsTab(window, app);
  await settings.locator(".aya-settings-add", { hasText: "Add custom" }).click();

  // Name filled, command left empty -> validation must block Save.
  await nameInput(settings).fill("Broken");
  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();

  // Settings stays open with an error, and nothing is persisted.
  await expect(settings).toBeVisible();
  await expect(settings.locator(".aya-settings-errors")).toContainText(/command/i);
  const names = JSON.parse(readFileSync(join(seeded.ayaHome, "presets.json"), "utf8")).presets.map(
    (p: { name: string }) => p.name,
  );
  expect(names).not.toContain("Broken");
});
