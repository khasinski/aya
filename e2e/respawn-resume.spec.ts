import { test, expect } from "./fixtures";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// Continuity across IN-SESSION respawns (the "empty console after a reload"
// report): a launcher-opened agent tab is NOT boot-restored, so its FIRST
// spawn must not carry a resume flag - but once it has run a session
// (confirmed live output - wasSpawned, #67), a restart must respawn WITH the
// resume flag, or the agent starts a brand-new empty session and the user's
// conversation is lost.
//
// Two restart paths are covered, and they are the only two user-facing ones:
//  - right-click sidebar -> "Restart terminal" (App.forceRestartTerminal)
//  - Shift+Enter in an exited terminal (App.restartTerminal)
// Both must spawn via the restartTrigger effect, AFTER the `restored` flip
// re-renders - a direct spawn from the event handler reads the pre-render
// command and silently drops the resume arg (the race this spec pins).
//
// Marker trick: the preset is inferred as claude via CLAUDE_CONFIG_DIR= and
// pipes `echo run` into `tee -- respawn-marker.txt`. The `echo` output marks
// the tab as having run (wasSpawned needs confirmed live output); the `--`
// makes tee treat EVERYTHING after it as an output file, so the ` --continue`
// Aya appends on a resuming respawn becomes a second tee output file. The
// assertion is therefore file EXISTENCE in the project cwd:
//   fresh spawn   -> respawn-marker.txt only
//   resuming spawn -> respawn-marker.txt AND a file literally named --continue
// This works on both GNU and BSD tee (without `--`, GNU tee would reject
// --continue as an unknown option and write nothing).
//
// CI-only: needs real PTY execution.
test.skip(!process.env.CI, "needs real PTY execution (unavailable in local sandbox)");

test.use({
  seedOptions: {
    split: false,
    presetList: [
      {
        id: "shell",
        name: "Shell",
        icon: "$",
        color: "",
        // NOT an agent - keeps the seeded boot-restored tabs out of the way.
        command: "$SHELL",
      },
      {
        id: "marker",
        name: "Marker",
        icon: "m",
        color: "",
        // Agent-inferred (CLAUDE_CONFIG_DIR=). NOTE: no `sh -c` wrapper (the
        // `-c` token trips commandHasResumeFlag and suppresses the append),
        // and nothing after the tee file list (the resume arg is appended at
        // the END of the command line and must land on tee's operands).
        command: "CLAUDE_CONFIG_DIR=/tmp/aya-e2e-rr echo run | tee -- respawn-marker.txt",
      },
    ],
  },
});

// Opens a Marker tab from the classic launcher (restored=false), waits until
// the renderer has processed the whole first run, and returns the two paths
// the assertions poll. The status dot is the deterministic "renderer caught
// up" signal: a new tab starts as `running` and only turns `idle` when the
// exit(0) event lands - which the event bus processes strictly AFTER the
// `run` output that marks the tab as having had a session. (The exit hint
// printed into xterm is not readable here - the single view may render via
// WebGL, which leaves .xterm-rows empty.)
async function openMarkerTabAndFinishFirstRun(window: Page, projectDir: string) {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.locator(".aya-launcher .aya-launcher-btn", { hasText: "Marker" }).click();
  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(3);

  const markerRow = window.locator('[data-terminal-name="Marker"]');
  await expect(markerRow.locator(".aya-sidebar-statusdot--idle")).toBeVisible({
    timeout: 10_000,
  });

  const markerPath = join(projectDir, "respawn-marker.txt");
  const continuePath = join(projectDir, "--continue");
  expect(existsSync(markerPath), "first spawn must have run (tee wrote the marker)").toBe(true);
  expect(
    existsSync(continuePath),
    "first spawn of a launcher tab must be a fresh session (no resume arg)",
  ).toBe(false);
  return { markerRow, continuePath };
}

test("right-click Restart of a launcher-opened agent tab resumes the session", async ({
  window,
  seeded,
}) => {
  const { markerRow, continuePath } = await openMarkerTabAndFinishFirstRun(
    window,
    seeded.projectDir,
  );

  await markerRow.click({ button: "right" });
  const menu = window.locator(".aya-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByText("Restart terminal").click();

  // The respawn must carry the resume arg - the tab already had a session.
  await expect.poll(() => existsSync(continuePath), { timeout: 10_000 }).toBe(true);
});

test("Shift+Enter restart of an exited launcher-opened agent tab resumes the session", async ({
  window,
  seeded,
}) => {
  const { continuePath } = await openMarkerTabAndFinishFirstRun(window, seeded.projectDir);

  // The Marker tab is active (launcher opens select it) and has exited with
  // code 0, so the custom key handler honors Shift+Enter as "restart".
  await window.getByTestId("xterm-host").first().click();
  await window.keyboard.press("Shift+Enter");

  await expect.poll(() => existsSync(continuePath), { timeout: 10_000 }).toBe(true);
});
