import { test, expect } from "./fixtures";
import { waitForShellReady } from "./helpers/terminal";

type Marked = Window & { __beforeReload?: boolean };

// The error screen's "Reload window" goes through the main process: a location.reload() from the
// page was cancelled. The page starts over and comes back to the same shells, not new ones.
test("reloadWindow starts the page over and comes back to the same running shell", async ({ window }) => {
  await waitForShellReady(window);
  const pane = window.locator('[data-testid="terminal-pane"]:visible').first();
  const id = (await pane.getAttribute("data-terminal-id"))!;
  // A variable only this shell process has: a new shell after the reload would print it empty.
  await pane.getByTestId("xterm-host").click();
  await window.keyboard.insertText("AYA_SAME_SHELL=kept");
  await window.keyboard.press("Enter");
  await window.evaluate(() => {
    (window as Marked).__beforeReload = true;
  });

  await window.evaluate(() => void window.aya.reloadWindow());
  await expect.poll(() => window.evaluate(() => (window as Marked).__beforeReload === true).catch(() => true)).toBe(false);

  await expect(window.getByTestId("terminal-pane")).toHaveCount(2);
  const again = window.locator(`[data-testid="terminal-pane"][data-terminal-id="${id}"]`);
  await again.getByTestId("xterm-host").click();
  await window.keyboard.insertText('echo "same:$AYA_SAME_SHELL"');
  await window.keyboard.press("Enter");
  await expect.poll(() => window.evaluate((ptyId) => window.aya.ptyBuffer(ptyId), id)).toContain("same:kept");
});
