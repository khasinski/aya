import { test, expect } from "./fixtures";
import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";

// MissingDirModal: an open project whose directory does not exist queues a modal
// (App boot dir-check) offering "Create folder" (mkdir it) or "Use home for now"
// (fall back to $HOME, leaving the folder absent). These exercise the real
// side effects, not just the modal rendering.

test.use({ seedOptions: { missingDir: true } });

const modal = (w: Page) => w.locator(".aya-modal").filter({ hasText: "Directory not found" });

test("the modal appears for a project whose directory is missing", async ({
  window,
  seeded,
}) => {
  await expect(modal(window)).toBeVisible();
  // Sanity: the offending path is the one we deliberately left uncreated.
  expect(seeded.missingDirPath).toBeTruthy();
  expect(existsSync(seeded.missingDirPath!)).toBe(false);
});

test("'Create folder' actually creates the directory and dismisses the modal", async ({
  window,
  seeded,
}) => {
  await expect(modal(window)).toBeVisible();
  expect(existsSync(seeded.missingDirPath!)).toBe(false);

  await modal(window).locator(".aya-modal-btn--primary", { hasText: "Create folder" }).click();

  await expect(modal(window)).toBeHidden();
  // The real side effect: the folder now exists on disk.
  await expect.poll(() => existsSync(seeded.missingDirPath!)).toBe(true);
});

test("'Use home for now' dismisses the modal WITHOUT creating the directory", async ({
  window,
  seeded,
}) => {
  await expect(modal(window)).toBeVisible();

  await modal(window).locator(".aya-modal-btn", { hasText: "Use home for now" }).click();

  await expect(modal(window)).toBeHidden();
  // The fallback must NOT have created the folder (the user chose to skip it).
  expect(existsSync(seeded.missingDirPath!)).toBe(false);
});

// NOTE: MissingDirModal is an App-root overlay, rendered identically regardless
// of layout. Its "renders + works in the experimental (projects-left) layout"
// smoke is covered representatively by project-preset-import.spec.ts (the same
// overlay class) - duplicating it here adds no signal, and switching layout with
// THIS modal open collides on the Escape key (both the missing-dir modal and the
// Settings dialog listen for it), which is a test-harness artifact, not product
// behavior worth pinning.
