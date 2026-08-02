import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

// The "Auto-resume restored tabs" preset toggle (Settings > Presets) and the
// real spawn behavior it controls: a restored agent tab appends the resume arg
// (--continue / resume --last) only when auto-resume is on.

async function openPresetsTab(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();
  return settings;
}

const savedAutoResume = (ayaHome: string, id: string): boolean | "absent" | "no-preset" => {
  try {
    const cfg = JSON.parse(readFileSync(join(ayaHome, "presets.json"), "utf8"));
    const p = (cfg.presets as Array<{ id: string; autoResume?: boolean }>).find((x) => x.id === id);
    if (!p) return "no-preset";
    return "autoResume" in p ? (p.autoResume as boolean) : "absent";
  } catch {
    return "no-preset";
  }
};

// --- Toggle persistence (UI + presets.json; runs locally) -----------------

test.describe("toggle persistence", () => {
  // A claude-inferred preset -> the toggle defaults ON for agents.
  test.use({
    seedOptions: {
      split: false,
      presetList: [{ id: "shell", name: "Claude", icon: "✻", color: "", command: "claude" }],
    },
  });

  test("Auto-resume defaults ON for an agent preset and persists OFF when unchecked", async ({
    window,
    app,
    seeded,
  }) => {
    const settings = await openPresetsTab(window, app);
    const toggle = settings
      .locator(".aya-preset-toggle", { hasText: "Auto-resume restored tabs" })
      .locator('input[type="checkbox"]');

    // Agent preset -> the UI shows it enabled by default.
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();
    await expect(settings).toBeHidden();

    // The deliberate opt-out is persisted as an explicit false (not dropped).
    await expect.poll(() => savedAutoResume(seeded.ayaHome, "shell")).toBe(false);
  });
});

// --- Real spawn behavior (marker echoes the appended args; CI-only: the local
//     sandbox does not execute PTYs, so the marker file is never written) ------

const markerCmd = 'CLAUDE_CONFIG_DIR=/tmp/aya-e2e-ar echo "$@" > resume-marker.txt';
const markerPath = (projectDir: string) => join(projectDir, "resume-marker.txt");

test.describe("real resume behavior", () => {
  // These drive a real PTY spawn (the marker command must execute); the local
  // sandbox does not exec PTYs, so run them only in CI where node-pty works.
  test.skip(!process.env.CI, "needs real PTY execution (unavailable in local sandbox)");

  test.describe("auto-resume ON", () => {
    test.use({
      seedOptions: {
        split: false,
        presetList: [{ id: "shell", name: "Claude", icon: "✻", color: "", command: markerCmd, autoResume: true }],
      },
    });

    test("a restored agent tab respawns WITH --continue", async ({ window, seeded }) => {
      await expect(window.getByTestId("xterm-host").first()).toBeVisible();
      // Marker is written by the spawned command; it must include the resume arg.
      await expect
        .poll(() => {
          try {
            return readFileSync(markerPath(seeded.projectDir), "utf8").includes("--continue");
          } catch {
            return false;
          }
        }, { timeout: 10_000 })
        .toBe(true);
    });
  });

  test.describe("auto-resume OFF", () => {
    test.use({
      seedOptions: {
        split: false,
        presetList: [{ id: "shell", name: "Claude", icon: "✻", color: "", command: markerCmd, autoResume: false }],
      },
    });

    test("a restored agent tab respawns WITHOUT --continue", async ({ window, seeded }) => {
      await expect(window.getByTestId("xterm-host").first()).toBeVisible();
      // Wait until the spawn actually ran (marker exists), then assert the arg is
      // absent - distinguishes "opted out" from "not spawned yet".
      await expect
        .poll(() => existsSync(markerPath(seeded.projectDir)), { timeout: 10_000 })
        .toBe(true);
      expect(readFileSync(markerPath(seeded.projectDir), "utf8")).not.toContain("--continue");
    });
  });
});
