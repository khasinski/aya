import type { BrowserWindow } from "electron";

type OpenTarget = Pick<BrowserWindow, "isDestroyed" | "once" | "removeListener"> & {
  webContents: Pick<
    BrowserWindow["webContents"],
    "isLoading" | "send" | "once" | "on" | "removeListener"
  >;
};

/** Send "open-project" to a page that can hear it. A loading page drops IPC,
 *  so the send waits for did-finish-load; closing or a failed load rejects. */
export function deliverOpenProject(win: OpenTarget, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (win.isDestroyed()) {
      reject(new Error("the window closed before it loaded"));
      return;
    }
    const { webContents } = win;
    if (!webContents.isLoading()) {
      webContents.send("open-project", dir);
      resolve();
      return;
    }
    const cleanup = () => {
      webContents.removeListener("did-finish-load", onLoad);
      webContents.removeListener("did-fail-load", onFail);
      win.removeListener("closed", onClosed);
    };
    // isLoading() can still read true here, so it is not checked again.
    const onLoad = () => {
      cleanup();
      webContents.send("open-project", dir);
      resolve();
    };
    const onFail = (
      _event: unknown,
      _code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return;
      cleanup();
      reject(new Error(`the page failed to load: ${description}`));
    };
    const onClosed = () => {
      cleanup();
      reject(new Error("the window closed before it loaded"));
    };
    webContents.once("did-finish-load", onLoad);
    webContents.on("did-fail-load", onFail);
    win.once("closed", onClosed);
  });
}
