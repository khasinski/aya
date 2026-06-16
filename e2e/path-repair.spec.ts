import { test, expect } from "./fixtures";

test.use({
  seedOptions: {
    presets: false,
    pathRepairHarness: true,
  },
});

test("GUI-style launch repairs PATH before first-launch harness scan", async ({
  window,
}) => {
  await expect(window.locator(".aya-launcher-btn", { hasText: "Claude Code" }))
    .toBeVisible();
  await expect(window.locator(".aya-launcher-btn", { hasText: "Shell" }))
    .toBeVisible();
});
