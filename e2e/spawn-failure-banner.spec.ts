import { test, expect } from "./fixtures";

// Spawn-failure recovery banner. An empty preset command makes the PTY preflight
// report preset-empty-command and render the banner (a deterministic failure
// that needs no missing binary / missing dir).

test.use({
  seedOptions: {
    presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "   " }],
  },
});

test("the recovery banner shows for an empty-command preset", async ({ window }) => {
  const banner = window.locator(".aya-pane-recovery").first();
  await expect(banner).toBeVisible();
  await expect(banner.locator(".aya-pane-recovery-text strong")).toHaveText("Preset command is empty");
  await expect(banner.locator(".aya-pane-recovery-btn", { hasText: "Open Settings" })).toBeVisible();
});

// ADVERSARIAL: the primary "Restart" button should re-attempt the spawn. The
// preset command is still empty, so a real retry fails again and the banner must
// reappear. If Restart only clears the banner (no re-spawn), this is RED - a
// misleading "Restart" that leaves a "running" terminal with no PTY.
test("the banner Restart re-attempts the spawn (banner reappears, command still empty)", async ({
  window,
}) => {
  const banner = window.locator(".aya-pane-recovery").first();
  await expect(banner).toBeVisible();
  await banner.locator(".aya-pane-recovery-btn--primary", { hasText: "Restart" }).click();

  await expect(window.locator(".aya-pane-recovery").first()).toBeVisible();
  await expect(
    window.locator(".aya-pane-recovery-text strong").first(),
  ).toHaveText("Preset command is empty");
});
