import { test, expect } from "./fixtures";
import { openPresetsTab } from "./helpers/settings";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// Settings > Presets editor: add a custom preset (-> appears as a sidebar
// launcher + persists), and validation blocks an incomplete preset.

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

test("Claude in print mode is flagged for what it does to the pane, not for billing", async ({ window, app }) => {
  const settings = await openPresetsTab(window, app);
  await settings.locator(".aya-settings-add", { hasText: "Add custom" }).click();
  const warning = settings.locator(".aya-settings-warn");

  await commandInput(settings).fill("claude -p");
  await expect(warning).toContainText("non-interactive (print) mode");
  await expect(warning).toContainText("will not be an interactive Claude session");
  // claude -p draws from subscription limits too (support.claude.com, updated 2026-10-07): no billing claim.
  await expect(warning).not.toContainText(/billing|subscription/i);

  // Interactive Claude, and other tools' -p flags, get no warning.
  await commandInput(settings).fill("claude --resume");
  await expect(warning).toHaveCount(0);
  await commandInput(settings).fill("ssh -p 2222 devbox");
  await expect(warning).toHaveCount(0);
});

test("conversation GUI toggle stays beside its label and saves the chosen interface", async ({ window, app, seeded }) => {
  const settings = await openPresetsTab(window, app);
  await settings.locator(".aya-settings-add", { hasText: "Add Codex" }).click();
  const toggle = settings.getByRole("checkbox", { name: "Conversation GUI · Experimental", exact: true });
  await expect(toggle).toBeEnabled();
  await toggle.check();
  const label = toggle.locator("..");
  const textBox = await label.locator("span").boundingBox();
  const checkboxBox = await toggle.boundingBox();
  expect(textBox).not.toBeNull();
  expect(checkboxBox).not.toBeNull();
  expect(checkboxBox!.width).toBe(16);
  expect(checkboxBox!.height).toBe(16);
  expect(checkboxBox!.x).toBeGreaterThan(textBox!.x + textBox!.width);
  expect(checkboxBox!.y).toBeLessThan(textBox!.y + textBox!.height);
  await nameInput(settings).fill("GUI Codex");
  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();
  await expect(settings).toBeHidden();
  const presets = JSON.parse(readFileSync(join(seeded.ayaHome, "presets.json"), "utf8")).presets;
  expect(presets.find((p: { name: string }) => p.name === "GUI Codex").interfaceMode).toBe("gui");
});
