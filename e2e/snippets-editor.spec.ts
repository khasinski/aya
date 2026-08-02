import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

// Settings > Snippets editor (add / edit / remove / autoRun toggle). Assertions
// are round-trips through the on-disk ~/.aya/snippets.json so a mutator that
// silently drops a field or an id-dedup that mangles data is caught.

async function openSnippets(app: ElectronApplication, window: Page) {
  // Let the renderer finish its initial load before firing a main-process
  // shortcut, else app.evaluate can race a startup navigation.
  await window.waitForLoadState("load");
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Snippets" }).click();
  // Tie readiness to loaded snippet data (the seeded default row), else editing
  // can race the async list load and the dirty guard blocks the prop sync.
  await expect(settings.locator(".aya-settings-snippet-row").first()).toBeVisible();
  return settings;
}

function diskSnippets(ayaHome: string): Array<{ id: string; name: string; text: string; autoRun: boolean }> | null {
  try {
    return JSON.parse(readFileSync(join(ayaHome, "snippets.json"), "utf8")).snippets;
  } catch {
    return null;
  }
}

test("adding a snippet persists its name, text, and the autoRun flag", async ({
  window,
  app,
  seeded,
}) => {
  const settings = await openSnippets(app, window);
  const rows = settings.locator(".aya-settings-snippet-row");
  const before = await rows.count();

  await settings.locator(".aya-settings-add").click();
  await expect(rows).toHaveCount(before + 1);

  const row = rows.last();
  await row.locator(".aya-settings-snippet-name").fill("e2e run snippet");
  await row.locator(".aya-settings-snippet-text").fill("echo hello");
  // New rows default to type-only (hold); flip to run-on-send so we can assert
  // the boolean round-trips (not silently coerced to the default).
  await expect(row.locator(".aya-snippet-runtoggle--hold")).toBeVisible();
  await row.locator(".aya-snippet-runtoggle").click();
  await expect(row.locator(".aya-snippet-runtoggle--run")).toBeVisible();

  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();

  await expect
    .poll(() => {
      const m = diskSnippets(seeded.ayaHome)?.find((s) => s.name === "e2e run snippet");
      return m ? { id: m.id, text: m.text, autoRun: m.autoRun } : null;
    })
    .toEqual({ id: "e2e-run-snippet", text: "echo hello", autoRun: true });
});

test("two snippets sharing a derived id are persisted under distinct ids", async ({
  window,
  app,
  seeded,
}) => {
  const settings = await openSnippets(app, window);
  const rows = settings.locator(".aya-settings-snippet-row");
  const before = await rows.count();

  await settings.locator(".aya-settings-add").click();
  await settings.locator(".aya-settings-add").click();
  await expect(rows).toHaveCount(before + 2);

  // Same label -> same presetSlug id -> the editor must dedup on save so one
  // does not clobber the other (first keeps id, second gets a "-2" suffix).
  for (const [i, text] of [[before, "first body"], [before + 1, "second body"]] as const) {
    await rows.nth(i).locator(".aya-settings-snippet-name").fill("dup label");
    await rows.nth(i).locator(".aya-settings-snippet-text").fill(text);
  }

  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();

  // Assert the id->text mapping (not just ids): a dedup that renamed correctly
  // but merged/swapped bodies must still fail.
  await expect
    .poll(() => {
      const dups = diskSnippets(seeded.ayaHome)
        ?.filter((s) => s.name === "dup label")
        .map((s) => ({ id: s.id, text: s.text }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return dups ?? null;
    })
    .toEqual([
      { id: "dup-label", text: "first body" },
      { id: "dup-label-2", text: "second body" },
    ]);
});

test("removing a snippet (native confirm) drops it from disk", async ({
  window,
  app,
  seeded,
}) => {
  const settings = await openSnippets(app, window);
  const rows = settings.locator(".aya-settings-snippet-row");
  const before = await rows.count();
  expect(before).toBeGreaterThan(0);

  const removedName = (
    await rows.first().locator(".aya-settings-snippet-name").inputValue()
  ).trim();
  expect(removedName).toBeTruthy();

  window.once("dialog", (d) => d.accept());
  await rows.first().locator(".aya-settings-row-close").click();
  await expect(rows).toHaveCount(before - 1);

  await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();

  await expect
    .poll(() => {
      const s = diskSnippets(seeded.ayaHome);
      return s ? s.some((x) => x.name === removedName) : null;
    })
    .toBe(false);
});
