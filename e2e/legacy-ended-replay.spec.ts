import { test, expect } from "./fixtures";
import { waitForShellReady } from "./helpers/terminal";

test.use({ seedOptions: { split: false } });

test("legacy replay with unknown terminal modes is visibly marked as an uncertain screen", async ({ app, window }) => {
  await waitForShellReady(window);
  const pane = window.locator('[data-testid="terminal-pane"]:visible').first();
  const paneId = await pane.getAttribute("data-terminal-id");
  expect(paneId).toBeTruthy();

  await app.evaluate(({ BrowserWindow }, id) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("seeded app window is missing");
    win.webContents.send("pty:event", {
      type: "data",
      ptyId: id,
      chunk: "retained output after the old mode-setting bytes were evicted",
      replay: true,
      reset: true,
      replayModeUnknown: true,
    });
  }, paneId!);

  await expect(pane.getByTestId("terminal-history-notice")).toHaveText(
    "The retained output's terminal mode is unknown; its previous screen layout may not be preserved.",
  );
});
