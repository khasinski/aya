import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// ProjectPresetImportModal: a project's .aya/project.json suggesting launchers
// not already present prompts to import them. "Import launchers" merges into
// presets.json (with a collision-safe id); "Ignore" leaves presets untouched.

const REPO_PRESET = {
  id: "repo-tool",
  name: "Repo Tool",
  icon: "R",
  color: "#8957e5",
  command: "repo-tool --from-aya-json",
};

const modal = (w: Page) =>
  w.locator(".aya-project-import-modal").filter({ hasText: "Import project launchers?" });

const savedPresetCommands = (ayaHome: string): string[] => {
  try {
    const cfg = JSON.parse(readFileSync(join(ayaHome, "presets.json"), "utf8"));
    return (cfg.presets as Array<{ command: string }>).map((p) => p.command);
  } catch {
    return [];
  }
};

test.describe("import flow", () => {
  test.use({ seedOptions: { repoPresets: [REPO_PRESET] } });

  test("the modal suggests the repo launcher", async ({ window }) => {
    await expect(modal(window)).toBeVisible();
    await expect(modal(window).locator(".aya-project-import-row")).toHaveCount(1);
    await expect(modal(window).getByText(REPO_PRESET.command)).toBeVisible();
  });

  test("'Import launchers' merges the repo preset into presets.json", async ({
    window,
    seeded,
  }) => {
    await expect(modal(window)).toBeVisible();
    expect(savedPresetCommands(seeded.ayaHome)).not.toContain(REPO_PRESET.command);

    await modal(window).locator(".aya-modal-btn--primary", { hasText: "Import launchers" }).click();

    await expect(modal(window)).toBeHidden();
    // Persisted: the repo command is now in the global preset store.
    await expect
      .poll(() => savedPresetCommands(seeded.ayaHome))
      .toContain(REPO_PRESET.command);
  });

  test("'Ignore' dismisses without importing anything", async ({ window, seeded }) => {
    await expect(modal(window)).toBeVisible();
    const before = savedPresetCommands(seeded.ayaHome);

    await modal(window).locator(".aya-modal-btn", { hasText: "Ignore" }).click();

    await expect(modal(window)).toBeHidden();
    // No preset added by ignoring.
    expect(savedPresetCommands(seeded.ayaHome)).not.toContain(REPO_PRESET.command);
    expect(savedPresetCommands(seeded.ayaHome).length).toBe(before.length);
  });
});

test.describe("dedup filter", () => {
  // A repo preset whose command duplicates an existing preset ($SHELL is the
  // seeded shell) must be filtered out of the suggestions. With ONLY a duplicate
  // suggested, there is nothing new -> no modal at all.
  test.use({
    seedOptions: {
      repoPresets: [{ id: "dup", name: "Dup Shell", icon: "$", color: "", command: "$SHELL" }],
    },
  });

  test("a repo preset duplicating an existing command does not prompt", async ({
    window,
  }) => {
    // The terminal is up; give the repo-config check time to run and decide.
    await expect(window.locator('[data-testid="terminal-pane"]').first()).toBeVisible();
    await window.waitForTimeout(800);
    await expect(modal(window)).toHaveCount(0);
  });
});
