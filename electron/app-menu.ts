// Application menu actions use main's live windows and host state.

import type { App, BrowserWindow, Menu, MenuItemConstructorOptions, nativeImage } from "electron";
import { deflateSync } from "node:zlib";
import type { PtyHostClient } from "./pty-host-client";

const STALE_MENU_DOT_PX = 16;
const STALE_MENU_DOT_SCALE_FACTOR = 2;

export interface MenuTemplateDeps {
  app: Pick<App, "relaunch" | "quit">;
  platform: NodeJS.Platform;
  windowTitle: string;
  maxKeyboardProjects: number;
  staleHostDetected: () => boolean;
  confirmLosingWork: (action: string, yes: string) => Promise<boolean>;
  ptyHost: Pick<PtyHostClient, "restart">;
  showAyaAboutPanel: () => void;
  dispatchShortcut: (action: string) => void;
  openNewWindow: () => Promise<unknown>;
  focusedAyaWindow: () => BrowserWindow | null;
  toggleAyaFullScreen: (win: BrowserWindow | null) => void;
}

export interface ApplicationMenuDeps extends MenuTemplateDeps {
  configureAppIdentity: () => void;
  Menu: Pick<typeof Menu, "buildFromTemplate" | "setApplicationMenu">;
}

export interface MenuIconDeps {
  Menu: Pick<typeof Menu, "getApplicationMenu">;
  nativeImage: Pick<typeof nativeImage, "createFromBuffer">;
}

/** Build a minimal RGBA PNG containing a filled circle.
 *  Uses only Node built-ins (zlib deflate + manual PNG framing). */
export function makeCirclePng(size: number, r: number, g: number, b: number): Buffer {
  const cx = size / 2;
  const cy = size / 2;
  const r2 = (size / 2 - 1) ** 2; // squared radius (1px inset so circle doesn't clip)
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0); // PNG filter byte: None
    for (let x = 0; x < size; x++) {
      const inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2;
      rows.push(r, g, b, inside ? 255 : 0);
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, "ascii");
    let c = 0xffffffff;
    for (const byte of Buffer.concat([t, data])) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function buildMenuTemplate(deps: MenuTemplateDeps): MenuItemConstructorOptions[] {
  const restartItem: MenuItemConstructorOptions = {
    id: "restart-aya",
    label: `Restart ${deps.windowTitle}`,
    click: async () => {
      // Only a stale host is restarted with Aya; a current one keeps its panes running.
      if (deps.staleHostDetected() && !(await deps.confirmLosingWork(`Restarting ${deps.windowTitle}`, "Restart").catch(() => true))) return;
      try {
        if (deps.staleHostDetected()) await deps.ptyHost.restart();
      } catch {
        // best-effort; stale host may already be gone
      }
      deps.app.relaunch();
      deps.app.quit();
    },
  };
  const appMenu: MenuItemConstructorOptions = {
    label: deps.windowTitle,
    submenu: [
      {
        label: `About ${deps.windowTitle}`,
        click: deps.showAyaAboutPanel,
      },
      { type: "separator" },
      {
        label: "Settings...",
        accelerator: "CmdOrCtrl+,",
        click: () => deps.dispatchShortcut("open-settings"),
      },
      restartItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(deps.platform === "darwin" ? [appMenu] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Shell",
          accelerator: "CmdOrCtrl+T",
          click: () => deps.dispatchShortcut("new-shell"),
        },
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => void deps.openNewWindow(),
        },
        {
          label: "Close Terminal",
          accelerator: "CmdOrCtrl+W",
          click: () => deps.dispatchShortcut("close-tab"),
        },
        ...(deps.platform === "darwin"
          ? []
          : [
              { type: "separator" as const },
              restartItem,
            ]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Search",
          accelerator: "CmdOrCtrl+K",
          click: () => deps.dispatchShortcut("search"),
        },
        {
          label: "Find in Terminal",
          accelerator: "CmdOrCtrl+F",
          click: () => deps.dispatchShortcut("find-in-pane"),
        },
        { type: "separator" },
        {
          label: "Previous Terminal",
          accelerator: "CmdOrCtrl+[",
          click: () => deps.dispatchShortcut("prev-tab"),
        },
        {
          label: "Next Terminal",
          accelerator: "CmdOrCtrl+]",
          click: () => deps.dispatchShortcut("next-tab"),
        },
        { type: "separator" },
        {
          label: "Focus Pane Left",
          accelerator: "CmdOrCtrl+Alt+Left",
          click: () => deps.dispatchShortcut("focus-pane-left"),
        },
        {
          label: "Focus Pane Right",
          accelerator: "CmdOrCtrl+Alt+Right",
          click: () => deps.dispatchShortcut("focus-pane-right"),
        },
        {
          label: "Focus Pane Up",
          accelerator: "CmdOrCtrl+Alt+Up",
          click: () => deps.dispatchShortcut("focus-pane-up"),
        },
        {
          label: "Focus Pane Down",
          accelerator: "CmdOrCtrl+Alt+Down",
          click: () => deps.dispatchShortcut("focus-pane-down"),
        },
        {
          label: "Split Pane Right",
          accelerator: "CmdOrCtrl+Alt+\\",
          click: () => deps.dispatchShortcut("split-pane-right"),
        },
        {
          label: "Split Pane Below",
          accelerator: "CmdOrCtrl+Alt+-",
          click: () => deps.dispatchShortcut("split-pane-below"),
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        {
          label: "Toggle Full Screen",
          accelerator:
            deps.platform === "darwin" ? "Ctrl+Command+F" : "F11",
          click: () => deps.toggleAyaFullScreen(deps.focusedAyaWindow()),
        },
      ],
    },
    {
      label: "Project",
      submenu: Array.from({ length: deps.maxKeyboardProjects }, (_, i) => ({
        label: `Select Project ${i + 1}`,
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => deps.dispatchShortcut(`project-${i + 1}`),
      })),
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(deps.platform === "darwin"
          ? [
              { type: "separator" as const },
              { role: "front" as const },
              { type: "separator" as const },
              { role: "window" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  if (deps.platform !== "darwin") {
    template.push({
      label: "Help",
      submenu: [
        {
          label: `About ${deps.windowTitle}`,
          click: deps.showAyaAboutPanel,
        },
      ],
    });
  }

  return template;
}

export function installApplicationMenu(deps: ApplicationMenuDeps): void {
  deps.configureAppIdentity();
  deps.Menu.setApplicationMenu(deps.Menu.buildFromTemplate(buildMenuTemplate(deps)));
}

/** Red dot on the "Restart Aya" menu item - the manual reap affordance (#52).
 *  No-op until the application menu is installed. */
export function setStaleMenuIcon(deps: MenuIconDeps): void {
  const item = deps.Menu.getApplicationMenu()?.getMenuItemById("restart-aya");
  if (item) {
    // 16x16 px red dot at scaleFactor 2 = 8pt logical - renders as a
    // small colored circle to the left of the label (standard macOS pattern).
    item.icon = deps.nativeImage.createFromBuffer(
      makeCirclePng(STALE_MENU_DOT_PX, 255, 59, 48), // red (macOS systemRed #ff3b30)
      { scaleFactor: STALE_MENU_DOT_SCALE_FACTOR },
    );
  }
}

