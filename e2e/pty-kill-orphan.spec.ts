import { KILL_ESCALATE_MS } from "../dist-electron/pty.js";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { statSync } from "node:fs";
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
// Heartbeat cadence of the trap-HUP fixture; the quiet-probe wait below spans
// several intervals so an alive process cannot look idle.
const HEARTBEAT_INTERVAL_MS = 150;
// Timings anchored to the production grace window (values preserved: 700/2000).
const GRACE_WINDOW_PROBE_TIMEOUT_MS = KILL_ESCALATE_MS - 50;
const POST_ESCALATION_SETTLE_MS = KILL_ESCALATE_MS + 1250;
const HEARTBEAT_QUIET_PROBE_MS = 700; // >= several heartbeat intervals

const HEARTBEAT_CMD =
  `sh -c 'trap "" HUP; while :; do echo tick >> "hb-$AYA_TERMINAL_ID.txt"; sleep ${HEARTBEAT_INTERVAL_MS / 1000}; done'`;

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
  const beforeClose = hbSize(seeded.projectDir, activeTab);

  // Close the active tab -> killPty -> graceful SIGHUP (ignored by the trap) then
  // SIGKILL escalation.
  await fireShortcut(app, "close-tab");

  // First prove the process SURVIVES the graceful kill: inside the grace window
  // (before the 750ms escalation) the trap-HUP loop keeps appending. This ASSERTS
  // SIGHUP-resistance rather than assuming it from the fixture string - if the
  // graceful signal alone killed the process (e.g. the trap silently broke, or
  // node-pty's default signal changed), this fails RED instead of letting the
  // test quietly decay into a facade.
  await expect
    .poll(() => hbSize(seeded.projectDir, activeTab), { timeout: GRACE_WINDOW_PROBE_TIMEOUT_MS })
    .toBeGreaterThan(beforeClose);

  // Then prove the escalation actually kills it: past the 750ms window the file
  // stops growing. (Orphan bug: a survivor would keep appending forever.)
  await window.waitForTimeout(POST_ESCALATION_SETTLE_MS);
  const s1 = hbSize(seeded.projectDir, activeTab);
  await window.waitForTimeout(HEARTBEAT_QUIET_PROBE_MS); // > the heartbeat interval
  const s2 = hbSize(seeded.projectDir, activeTab);
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
