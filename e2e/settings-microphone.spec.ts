import { test, expect } from "./fixtures";

// The "Microphone" row in Settings > General is the user-facing transparency for
// the mic entitlement: it explains Aya never records, shows the live macOS
// permission status, and offers an action (Allow / Manage / Open System
// Settings). Renders only on macOS (getMediaAccessStatus is macOS-only).

test.skip(
  process.platform !== "darwin",
  "Microphone settings row is macOS-only",
);

test("Settings > General shows the Microphone permission row with status and an action", async ({
  window,
}) => {
  await window.locator('button[title="Settings"]').click();
  // Land on the General tab (the Microphone row lives there).
  await window.locator(".aya-settings-tab", { hasText: "General" }).click();

  const micRow = window.locator(".aya-settings-general-row", {
    has: window.locator(".aya-settings-general-title", { hasText: "Microphone" }),
  });
  await expect(micRow).toBeVisible();

  // Transparency copy: Aya never records, and the live macOS status is shown.
  await expect(micRow.locator(".aya-modal-hint")).toContainText(
    /Aya never records/i,
  );
  await expect(micRow.locator(".aya-modal-hint")).toContainText(
    /macOS permission:\s*(granted|denied|not-determined|restricted|unknown)/i,
  );

  // An action button is present (its label depends on the current status).
  await expect(
    micRow.locator(".aya-settings-control button"),
  ).toBeVisible();
});
