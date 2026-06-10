import { test, expect } from "./fixtures";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Creating a project via the top-bar "+" had no e2e coverage at all, even though
// it is a core flow. These cover the happy path (a real directory becomes a new
// active project tab named after its basename) and the validation guard (a
// non-existent directory is rejected inline, not silently turned into a broken
// project).

test("the + button opens a real directory as a new active project", async ({
  window,
  seeded,
}) => {
  // A real directory the app's dirExists check will accept.
  const dir = join(seeded.root, "freshproj");
  mkdirSync(dir);

  await window.locator(".aya-tab-new").click();
  const input = window.locator(".aya-modal-input");
  await expect(input).toBeVisible();
  await input.fill(dir);
  await window.locator(".aya-modal-btn--primary").click();

  // A new project tab named after the directory's basename becomes active.
  await expect(
    window.locator(".aya-tab--active .aya-tab-name"),
  ).toHaveText(/freshproj/);
  // The modal closed (no input left on screen).
  await expect(window.locator(".aya-modal-input")).toHaveCount(0);
});

test("a non-existent directory is rejected inline, no project is created", async ({
  window,
  seeded,
}) => {
  const missing = join(seeded.root, "does-not-exist-xyz");

  await window.locator(".aya-tab-new").click();
  const input = window.locator(".aya-modal-input");
  await expect(input).toBeVisible();
  await input.fill(missing);
  await window.locator(".aya-modal-btn--primary").click();

  // Inline error, modal stays open, no new project tab appears.
  await expect(window.locator(".aya-modal-error")).toContainText(
    /directory does not exist/i,
  );
  await expect(window.locator(".aya-modal-input")).toBeVisible();
  await expect(
    window.locator(".aya-tab-name", { hasText: "does-not-exist-xyz" }),
  ).toHaveCount(0);
});
