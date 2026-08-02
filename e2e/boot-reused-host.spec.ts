import { test, expect } from "./fixtures";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Boot against a REUSED PTY host (one that predates the app session): the
// boot-restored tabs' sessions are gone from that host, so they must come up
// STOPPED/restartable - NOT silently auto-respawn a brand-new process (the
// same maintainer decision as for manual host restarts). Shift+Enter then
// restarts WITH the resume arg, so the user keeps continuity on their own
// terms. The cold-boot counterpart (fresh host -> tabs auto-start, resume
// flag included) is pinned by agent-resume.spec.ts - together the two specs
// hold the attachIfReused gate from both sides.
//
// Same tee marker trick as respawn-resume.spec.ts: the seeded "shell" preset
// is claude-inferred (CLAUDE_CONFIG_DIR=) and pipes echo into
// `tee -- boot-marker.txt`, so file existence tells whether a process EVER
// ran, and the resume arg appended on restart lands after `--` and becomes a
// second output file.
//
// Runs locally too: every spawn in this spec goes through the PRE-STARTED
// host, which runs under plain node - the "no PTY execution in the local
// sandbox" limitation only applies to the Electron-spawned host.

test.use({
  seedOptions: {
    split: false,
    preStartPtyHost: true,
    presetList: [
      {
        id: "shell",
        name: "Shell",
        icon: "$",
        color: "",
        command: "CLAUDE_CONFIG_DIR=/tmp/aya-e2e-brh echo run | tee -- boot-marker.txt",
      },
    ],
  },
});

test("boot-restored tabs on a reused host come up stopped, and Shift+Enter resumes", async ({
  window,
  seeded,
}) => {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();

  const markerPath = join(seeded.projectDir, "boot-marker.txt");
  const continuePath = join(seeded.projectDir, "--continue");

  // The mounted boot tab attaches, finds no session, and goes stopped: the
  // status dot flips running -> idle with NO process run in between. Only
  // after the renderer visibly processed that no-session is the marker
  // absence meaningful (a plain "not yet spawned" would also lack the file).
  await expect(
    window.locator('[data-testid="sidebar-terminal"] .aya-sidebar-statusdot--idle').first(),
  ).toBeVisible({ timeout: 10_000 });
  expect(
    existsSync(markerPath),
    "a boot-restored tab on a reused host must NOT auto-respawn",
  ).toBe(false);

  // Shift+Enter on the stopped tab restarts it - as a RESUMED session
  // (restored=true), so tee gets the appended --continue as a second file.
  await window.getByTestId("xterm-host").first().click();
  await window.keyboard.press("Shift+Enter");

  await expect.poll(() => existsSync(markerPath), { timeout: 10_000 }).toBe(true);
  await expect.poll(() => existsSync(continuePath), { timeout: 10_000 }).toBe(true);
});
