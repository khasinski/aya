import { test, expect } from "./fixtures";

// The project tab is two-line: the name (identity) on top, the quieter
// path/summary line under it. Guards the .aya-tab-text wrapper layout.

test("project tabs render the name above the path", async ({ window }) => {
  await expect(window.locator(".aya-tab")).toHaveCount(1);
  await expect(
    window.locator(".aya-tab .aya-tab-text .aya-tab-name"),
  ).toBeVisible();
  await expect(
    window.locator(".aya-tab .aya-tab-text .aya-tab-path"),
  ).toBeVisible();
  const nameBox = await window.locator(".aya-tab-name").boundingBox();
  const pathBox = await window.locator(".aya-tab-path").boundingBox();
  expect(nameBox!.y + nameBox!.height).toBeLessThanOrEqual(pathBox!.y + 1);
});
