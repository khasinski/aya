// The native macOS About panel and the custom panel used in dev and on other platforms.

import type { App, BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { readFileSync } from "node:fs";

// About dialog window dimensions (square, px)
const ABOUT_DIALOG_SIZE = 360;
// About dialog icon dimensions (square, px)
const ABOUT_ICON_SIZE = 128;

export interface AboutPanelDeps {
  app: Pick<App, "showAboutPanel" | "getVersion">;
  isDev: boolean;
  platform: NodeJS.Platform;
  windowTitle: string;
  darkBackground: string;
  lightText: string;
  focusedAyaWindow: () => BrowserWindow | null;
  createWindow: (options: BrowserWindowConstructorOptions) => Pick<BrowserWindow, "setMenu" | "loadURL" | "once" | "show">;
  devIconPath: () => string;
}

function devAboutIconPath(deps: AboutPanelDeps): string {
  return deps.devIconPath();
}

export function showAyaAboutPanel(deps: AboutPanelDeps): void {
  if (!deps.isDev && deps.platform === "darwin") {
    deps.app.showAboutPanel();
    return;
  }
  const parent = deps.focusedAyaWindow() ?? undefined;
  const about = deps.createWindow({
    width: ABOUT_DIALOG_SIZE,
    height: ABOUT_DIALOG_SIZE,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent,
    modal: !!parent,
    title: `About ${deps.windowTitle}`,
    backgroundColor: deps.darkBackground,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  about.setMenu(null);
  let iconUrl = "";
  try {
    const png = readFileSync(devAboutIconPath(deps));
    iconUrl = `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    // Empty src keeps the dialog usable even if the icon asset is missing.
  }
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        color: ${deps.lightText};
        background: ${deps.darkBackground};
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      main {
        width: 100%;
        padding: 28px 28px 24px;
        text-align: center;
      }
      img {
        display: block;
        width: ${ABOUT_ICON_SIZE}px;
        height: ${ABOUT_ICON_SIZE}px;
        margin: 0 auto 18px;
      }
      h1 {
        margin: 0;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: 0;
      }
      p {
        margin: 7px 0 0;
        font-size: 13px;
        color: #8b949e;
      }
      button {
        margin-top: 24px;
        min-width: 78px;
        height: 30px;
        border: 1px solid #30363d;
        border-radius: 6px;
        color: ${deps.lightText};
        background: #161b22;
        font: inherit;
        font-size: 13px;
      }
      button:hover { background: #21262d; }
    </style>
  </head>
  <body>
    <main>
      <img src="${iconUrl}" alt="">
      <h1>${deps.windowTitle}</h1>
      <p>Version ${deps.app.getVersion()}</p>
      <button autofocus onclick="window.close()">OK</button>
    </main>
  </body>
</html>`;
  about.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  about.once("ready-to-show", () => about.show());
}

