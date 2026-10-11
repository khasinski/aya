import { test, expect } from "./fixtures";

type Probe = Window & { __beforeReload?: boolean; aya: { reloadWindow(): Promise<void> } };

// The error screen's "Reload window" goes through the main process: a location.reload() from the
// page was cancelled. The page starts over and its terminals come back from the pty host.
test("reloadWindow starts the page over and the terminals come back", async ({ window }) => {
  const panes = window.getByTestId("terminal-pane");
  await expect(panes).toHaveCount(2);
  await window.evaluate(() => {
    (window as unknown as Probe).__beforeReload = true;
  });
  await window.evaluate(() => void (window as unknown as Probe).aya.reloadWindow());
  await expect
    .poll(() => window.evaluate(() => (window as unknown as Probe).__beforeReload === true).catch(() => true))
    .toBe(false);
  await expect(panes).toHaveCount(2);
});
