// About panel against a stand-in window and icons in a temporary directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { showAyaAboutPanel } = await import("../dist-electron/about-panel.js");

function setup(t, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aya-about-panel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const iconPath = join(dir, "icon.png");
  writeFileSync(iconPath, Buffer.from([1, 2, 3]));
  const log = [];
  const callbacks = new Map();
  let options;
  let url;
  const window = {
    setMenu: (menu) => log.push(["menu", menu]),
    loadURL: (value) => { url = value; log.push(["load"]); return Promise.resolve(); },
    once: (event, callback) => { callbacks.set(event, callback); log.push(["once", event]); },
    show: () => log.push(["show"]),
  };
  const deps = {
    app: { showAboutPanel: () => log.push(["native"]), getVersion: () => "1.2.3" },
    isDev: true,
    platform: "darwin",
    windowTitle: "Aya Dev",
    darkBackground: "#0d1117",
    lightText: "#f0f6fc",
    focusedAyaWindow: () => null,
    createWindow: (value) => { options = value; log.push(["create"]); return window; },
    devIconPath: () => iconPath,
    ...over,
  };
  return { deps, log, callbacks, options: () => options, url: () => url, iconPath };
}

test("packaged macOS uses the native About panel without touching windows or icons", (t) => {
  const s = setup(t, {
    isDev: false,
    focusedAyaWindow: () => assert.fail("no parent lookup"),
    createWindow: () => assert.fail("no custom window"),
    devIconPath: () => assert.fail("no icon lookup"),
    app: { showAboutPanel: () => {}, getVersion: () => assert.fail("no version lookup") },
  });
  s.deps.app.showAboutPanel = () => s.log.push(["native"]);
  showAyaAboutPanel(s.deps);
  assert.deepEqual(s.log, [["native"]]);
});

test("dev macOS custom panel preserves window options, HTML and show ordering", (t) => {
  const s = setup(t);
  showAyaAboutPanel(s.deps);
  assert.deepEqual(s.options(), {
    width: 360, height: 360, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, parent: undefined, modal: false, title: "About Aya Dev",
    backgroundColor: "#0d1117", show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  assert.deepEqual(s.log, [["create"], ["menu", null], ["load"], ["once", "ready-to-show"]]);
  assert.ok(s.url().startsWith("data:text/html;charset=utf-8,"));
  const html = decodeURIComponent(s.url().split(",").slice(1).join(","));
  assert.ok(html.includes('<img src="data:image/png;base64,AQID" alt="">'));
  assert.ok(html.includes("<h1>Aya Dev</h1>"));
  assert.ok(html.includes("<p>Version 1.2.3</p>"));
  assert.ok(html.includes('autofocus onclick="window.close()">OK</button>'));
  assert.ok(html.includes("width: 128px;"));
  assert.ok(html.includes("height: 128px;"));
  // Captured from the original panel with the same title, version and icon bytes.
  assert.equal(createHash("sha256").update(s.url()).digest("hex"),
    "7df0e67ecb42830318c8eaa856b861d99605667944c71f0e07574098f4e4b5b1");
  s.callbacks.get("ready-to-show")();
  assert.deepEqual(s.log.at(-1), ["show"]);
});

for (const platform of ["linux", "win32"]) {
  test(`packaged ${platform} custom panel is modal to the focused Aya window`, (t) => {
    const parent = { id: "parent" };
    const s = setup(t, { isDev: false, platform, windowTitle: "Aya", focusedAyaWindow: () => parent });
    showAyaAboutPanel(s.deps);
    assert.equal(s.options().parent, parent);
    assert.equal(s.options().modal, true);
    assert.equal(s.options().title, "About Aya");
    assert.ok(decodeURIComponent(s.url()).includes("<h1>Aya</h1>"));
    assert.equal(s.log.some(([action]) => action === "native"), false);
  });
}

test("a missing icon keeps an empty src and the custom panel still shows", (t) => {
  const s = setup(t);
  rmSync(s.iconPath);
  showAyaAboutPanel(s.deps);
  assert.ok(decodeURIComponent(s.url()).includes('<img src="" alt="">'));
  s.callbacks.get("ready-to-show")();
  assert.deepEqual(s.log.at(-1), ["show"]);
});
