import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

test.use({
  seedOptions: {
    pathRepairHarness: true,
  },
});

test("Settings suggests harnesses found after GUI-launch PATH repair", async ({
  window,
  app,
}) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();

  await expect(
    settings.locator(".aya-settings-section-title", {
      hasText: "Suggested (found on your PATH)",
    }),
  ).toBeVisible();
  await expect(
    settings.locator(".aya-settings-suggested-btn", { hasText: "Add Claude Code" }),
  ).toBeVisible();
});
