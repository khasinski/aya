import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

// Spawn-failure recovery banner. An empty preset command makes the PTY preflight
// report preset-empty-command and render the banner. Single-view seed so there
// is exactly one visible pane/banner (no split-pane .first() ambiguity).

test.use({
  seedOptions: {
    split: false,
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "   " }],
  },
});

const visibleBanner = (window: Page) => window.locator(".aya-pane-recovery:visible");

test("the recovery banner shows for an empty-command preset", async ({ window }) => {
  const banner = visibleBanner(window);
  await expect(banner).toBeVisible();
  await expect(banner.locator(".aya-pane-recovery-text strong")).toHaveText("Preset command is empty");
  await expect(banner.locator(".aya-pane-recovery-btn", { hasText: "Open Settings" })).toBeVisible();
});

// The banner's primary "Restart" must actually re-attempt the spawn. The preset
// command is still empty, so a real retry fails again and the banner stays. If
// Restart only clears spawnFailure without re-spawning, the banner vanishes and
// the terminal is left "running" with no PTY (a zombie) - this asserts it does NOT.
test("the banner Restart re-attempts the spawn instead of leaving a zombie terminal", async ({
  window,
}) => {
  const banner = visibleBanner(window);
  await expect(banner).toBeVisible();

  // Each spawn attempt echoes "[process exited with code 127]" into the
  // terminal (pty.ts reportSpawnFailure). The initial failure produced one.
  // A no-op clear-only Restart (the old zombie bug) leaves the banner visible
  // too, so asserting visibility alone would false-pass. A REAL respawn fails
  // again and writes a SECOND exit echo - count must reach 2.
  const exitEchoes = () =>
    window
      .locator(".aya-xterm-host:visible")
      .first()
      .innerText()
      .then((t) => (t.match(/process exited with code/g) || []).length);
  await expect.poll(exitEchoes).toBe(1);

  await banner.locator(".aya-pane-recovery-btn--primary", { hasText: "Restart" }).click();

  // Restart actually re-attempted the spawn (not a clear-only no-op).
  await expect.poll(exitEchoes).toBe(2);

  // Still broken (empty command) -> the failure banner must still be shown.
  await expect(visibleBanner(window)).toBeVisible();
  await expect(
    visibleBanner(window).locator(".aya-pane-recovery-text strong"),
  ).toHaveText("Preset command is empty");
});
