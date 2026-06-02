import type { ElectronApplication } from "@playwright/test";

/** Fire an Aya app shortcut action the way main.ts ultimately does — by sending
 *  the "shortcut" IPC straight to the renderer. Playwright's synthetic keyboard
 *  does NOT trigger main.ts's webContents before-input-event interception, so
 *  this is how we exercise shortcut-driven behavior (and whether focus follows)
 *  in E2E. Action strings match electron/main.ts: "search", "find-in-pane",
 *  "next-tab", "prev-tab", "focus-pane-right", "open-settings", etc. */
export async function fireShortcut(app: ElectronApplication, action: string) {
  await app.evaluate(({ BrowserWindow }, act) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send("shortcut", act);
  }, action);
}
