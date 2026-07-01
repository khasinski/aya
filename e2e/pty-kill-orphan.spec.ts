import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

// Switch to the experimental "Projects on left" layout (split disabled) via the
// Settings segmented control - mirrors projects-left-no-split.spec.ts (no shared
// helper exists).
async function enableProjectsLeftLayout(window: Page, app: ElectronApplication) {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings
    .locator('.aya-settings-segmented[aria-label="Window layout"] button', {
      hasText: "Projects on left",
    })
    .click();
  await window.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
}

// End-to-end reproduction of BUG-11 through the real app, in BOTH layouts: a tab
// whose process traps/ignores SIGHUP (like `claude --chrome`) must actually die
// when the tab is closed - the SIGKILL escalation guarantees it, so no orphan is
// left running. Without the fix the process survives the graceful kill and keeps
// appending to its heartbeat file (the orphan that then double-spawns).
//
// CI-only: needs a real PTY spawn (node-pty), which the local sandbox can't exec.
test.skip(!process.env.CI, "needs real PTY execution (unavailable in local sandbox)");

// Each tab writes to hb-<its AYA_TERMINAL_ID>.txt so a hidden sibling terminal
// can't pollute the file we watch. Traps HUP so a plain kill won't stop it.
const HEARTBEAT_CMD =
  'sh -c \'trap "" HUP; while :; do echo tick >> "hb-$AYA_TERMINAL_ID.txt"; sleep 0.15; done\'';

const hbSize = (dir: string, tabId: string): number => {
  const p = join(dir, `hb-${tabId}.txt`);
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
};

async function reproInLayout(
  window: Page,
  app: ElectronApplication,
  seeded: { projectDir: string; tabIds: { left: string } },
  projectsLeft: boolean,
) {
  if (projectsLeft) await enableProjectsLeftLayout(window, app);

  const activeTab = seeded.tabIds.left; // shell 1 boots active
  // The tab is mounted (a terminal pane rendered) so a heartbeat that never
  // appears means the SPAWN failed, not the kill path - a clear RED, not a
  // false pass. (Grok/Codex review: distinguish spawn failure from kill issue.)
  await expect(window.locator('[data-testid="terminal-pane"]:visible').first()).toBeVisible();
  // The tab's process is running and appending its heartbeat.
  await expect
    .poll(() => hbSize(seeded.projectDir, activeTab), { timeout: 10_000 })
    .toBeGreaterThan(0);

  // Close the active tab -> killPty -> SIGHUP (ignored) then SIGKILL escalation.
  await fireShortcut(app, "close-tab");

  // Past the 750ms escalation + margin, the process must be DEAD: the heartbeat
  // file stops growing. (Orphan bug: it would keep appending.)
  await window.waitForTimeout(2000);
  const s1 = hbSize(seeded.projectDir, activeTab);
  await window.waitForTimeout(700); // > the 150ms heartbeat interval
  const s2 = hbSize(seeded.projectDir, activeTab);
  expect(existsSync(join(seeded.projectDir, `hb-${activeTab}.txt`))).toBe(true);
  expect(s2).toBe(s1); // no further writes -> the process was actually killed
}

test.describe("classic layout", () => {
  test.use({ seedOptions: { split: false, presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: HEARTBEAT_CMD }] } });
  test("closing a SIGHUP-ignoring tab kills the process (no orphan)", async ({ window, app, seeded }) => {
    await reproInLayout(window, app, seeded, false);
  });
});

test.describe("experimental layout (projects-left)", () => {
  test.use({ seedOptions: { split: false, presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: HEARTBEAT_CMD }] } });
  test("closing a SIGHUP-ignoring tab kills the process (no orphan)", async ({ window, app, seeded }) => {
    await reproInLayout(window, app, seeded, true);
  });
});
