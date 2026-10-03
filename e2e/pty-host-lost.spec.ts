import { expect, hostPidsForHome, test } from "./fixtures";
import { firstTerminalShown, waitForShellReady } from "./helpers/terminal";

// A pty host dying under a running app takes the shell with it: the tab must then be stopped and
// restartable (Shift+Enter), not a live-looking pane whose process is gone.

test("a pty host killed under the running app leaves a tab Shift+Enter restarts", async ({ window, seeded }) => {
  await firstTerminalShown(window);
  await waitForShellReady(window);
  const pane = window.locator('[data-testid="terminal-pane"]:visible').first();
  const terminalId = (await pane.getAttribute("data-terminal-id"))!;
  const hosts = hostPidsForHome(seeded.ayaHome);
  expect(hosts.length).toBeGreaterThan(0);

  // Only this test's own host: found by its AYA_HOME, and a detached group leader.
  for (const pid of hosts) process.kill(-pid, "SIGKILL");
  await expect.poll(() => hostPidsForHome(seeded.ayaHome)).toEqual([]);

  // The host is gone, so a new empty one would answer with nothing until the shell runs again.
  await window.getByTestId("xterm-host").first().click();
  await window.keyboard.press("Shift+Enter");
  await expect
    .poll(() => window.evaluate((id) => window.aya.ptyBuffer(id).then((b) => b.length), terminalId), {
      message: "Shift+Enter did not start the shell again after its host was killed",
    })
    .toBeGreaterThan(0);
});
