import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Project tabs in the classic TopBar: inline rename (double-click) and close.
// Terminal rename was covered; project rename/close were not.

test("double-clicking a project tab renames it and persists to disk", async ({
  window,
  seeded,
}) => {
  const tab = window.locator(".aya-topbar .aya-tab").first();
  await expect(tab.locator(".aya-tab-name")).toHaveText("e2e");

  // Open the inline editor and rename. The whole gesture is retried because a
  // cold first render can swallow the double-click or the launch-time focus
  // grab can blur the editor the instant it opens; retrying makes it reliable.
  const input = tab.locator(".aya-tab-rename");
  await expect(async () => {
    await tab.locator(".aya-tab-name").dblclick();
    await input.fill("Renamed Project", { timeout: 800 });
    await input.press("Enter", { timeout: 800 });
  }).toPass({ timeout: 15000 });

  await expect(tab.locator(".aya-tab-name")).toHaveText("Renamed Project");
  await expect(window.locator(".aya-tab--active .aya-tab-name")).toHaveText("Renamed Project");

  // ...and the new name is actually written to the project file on disk.
  const projectFile = join(seeded.ayaHome, "projects", "e2e-proj.json");
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(projectFile, "utf8")).name;
      } catch {
        return null;
      }
    })
    .toBe("Renamed Project");
});

test("closing the only project tab drops to the empty state", async ({ window }) => {
  await expect(window.locator(".aya-topbar .aya-tab")).toHaveCount(1);

  const tab = window.locator(".aya-topbar .aya-tab").first();
  await tab.hover();
  await tab.locator(".aya-tab-close").click();

  await expect(window.locator(".aya-topbar .aya-tab")).toHaveCount(0);
  // the empty state offers to open a directory
  await expect(window.getByText("Open directory")).toBeVisible();
});
