import { test, expect } from "./fixtures";
import { enableProjectsLeftLayout } from "./helpers/layout";

// A burst of close-tab shortcuts must close one tab per press.
//
// The shortcut handler used to read `activeTabId` off render state. When the
// second press was handled before React committed the first close, it still
// saw the id it had just closed, looked up a terminal that was already gone,
// and silently did nothing - so a fast double Cmd+W closed one tab, not two.
//
// Sending both from one main-process evaluate does NOT by itself force that
// interleaving: in an otherwise idle app the renderer commits between the two
// IPC messages and the bug stays hidden. It needs a loaded event loop, which
// is why this only ever failed as part of the full suite (where it did fail,
// as did projects-left-launcher-empty, which closes two tabs the same way).
// Kept as the spec that names the behavior; the full-suite run is what
// actually exercises the race.

test.use({ seedOptions: { split: false } });

test("a burst of two close-tab shortcuts closes two tabs", async ({ window, app }) => {
  // The terminal-tab strip (and its testid) only exists in this layout.
  await enableProjectsLeftLayout(window, app);
  await expect(window.getByTestId("termtab")).toHaveCount(2);

  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    wc?.send("shortcut", "close-tab");
    wc?.send("shortcut", "close-tab");
  });

  await expect(window.getByTestId("termtab")).toHaveCount(0);
});
