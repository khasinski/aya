import type { BrowserWindow } from "electron";

type OpenTarget = Pick<BrowserWindow, "isDestroyed" | "once" | "removeListener"> & {
  webContents: Pick<
    BrowserWindow["webContents"],
    "isLoading" | "send" | "once" | "on" | "removeListener"
  >;
};

/** Chromium's net::ERR_ABORTED: a navigation replaced by another (a reload,
 *  a redirect), whose own did-finish-load still comes. */
const ERR_ABORTED = -3;

/** Opens sent to a window and not yet confirmed by its page: a reload throws away
 *  what the page had queued, so those are sent again once it has loaded. */
const unconfirmed = new WeakMap<object, string[]>();

function sendOpen(webContents: OpenTarget["webContents"], dir: string): void {
  const list = unconfirmed.get(webContents) ?? [];
  list.push(dir);
  unconfirmed.set(webContents, list);
  webContents.send("open-project", dir);
}

/** The page finished creating (or refused) the project `dir`; it need not be sent again. */
export function confirmOpen(webContents: object, dir: string): void {
  const list = unconfirmed.get(webContents) ?? [];
  const at = list.indexOf(dir);
  if (at !== -1) list.splice(at, 1);
}

/** Sends a window's unconfirmed opens again after each of its page loads. */
export function replayOpensOnLoad(win: Pick<BrowserWindow, "webContents">): void {
  win.webContents.on("did-finish-load", () => {
    for (const dir of unconfirmed.get(win.webContents) ?? []) win.webContents.send("open-project", dir);
  });
}

/** Send "open-project" to a page that can hear it. A loading page drops IPC,
 *  so the send waits for did-finish-load; closing, a failed load or a crashed
 *  renderer rejects. */
export function deliverOpenProject(win: OpenTarget, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (win.isDestroyed()) {
      reject(new Error("the window closed before it loaded"));
      return;
    }
    const { webContents } = win;
    if (!webContents.isLoading()) {
      sendOpen(webContents, dir);
      resolve();
      return;
    }
    const cleanup = () => {
      webContents.removeListener("did-finish-load", onLoad);
      webContents.removeListener("did-fail-load", onFail);
      webContents.removeListener("render-process-gone", onGone);
      win.removeListener("closed", onClosed);
    };
    // isLoading() can still read true here, so it is not checked again.
    const onLoad = () => {
      cleanup();
      sendOpen(webContents, dir);
      resolve();
    };
    const onFail = (
      _event: unknown,
      code: number,
      description: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      cleanup();
      reject(new Error(`the page failed to load: ${description}`));
    };
    const onGone = (_event: unknown, details: { reason: string }) => {
      cleanup();
      reject(new Error(`the page's renderer is gone: ${details.reason}`));
    };
    const onClosed = () => {
      cleanup();
      reject(new Error("the window closed before it loaded"));
    };
    webContents.once("did-finish-load", onLoad);
    webContents.on("did-fail-load", onFail);
    webContents.on("render-process-gone", onGone);
    win.once("closed", onClosed);
  });
}
