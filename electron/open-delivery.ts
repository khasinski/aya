import type { BrowserWindow } from "electron";
import { statSync } from "node:fs";
import * as path from "node:path";

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

/** The first positional argv value that is an existing directory (`aya /path/to/project`); in dev argv
 *  includes Electron's own args. */
export function findDirInArgv(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith("-")) continue;
    // Skip arguments that obviously aren't user-supplied paths.
    if (a.endsWith("main.js") || a.includes("node_modules/electron")) continue;
    if (a === ".") {
      // Relative-to-cwd. We get a sensible cwd from `second-instance`'s
      // workingDirectory arg; the initial argv case handles "." via
      // process.cwd().
      try {
        return path.resolve(process.cwd());
      } catch {
        continue;
      }
    }
    try {
      const resolved = path.resolve(a);
      if (statSync(resolved).isDirectory()) return resolved;
    } catch {
      // Not a real directory - keep searching.
      continue;
    }
  }
  return null;
}

/** An "open this project" request (another process, or our own argv) for the renderer, which switches to,
 *  creates, or ignores the project. */
export function dispatchOpenProject(
  deps: { window: OpenTarget | null },
  dir: string | null,
): Promise<void> {
  const { window: win } = deps;
  if (!win || !dir) return Promise.resolve();
  return deliverOpenProject(win, dir);
}

export function logOpenFailure(dir: string | null): (err: unknown) => void {
  return (err) => console.warn(`[aya] could not open ${dir}:`, err);
}
