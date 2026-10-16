// Application menu against stand-in actions and Electron menu/image APIs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

const { buildMenuTemplate, installApplicationMenu, makeCirclePng, setStaleMenuIcon } =
  await import("../dist-electron/app-menu.js");

function setup(over = {}) {
  const log = [];
  let focused = { id: "first" };
  let stale = false;
  const deps = {
    app: { relaunch: () => log.push(["relaunch"]), quit: () => log.push(["quit"]) },
    platform: "darwin",
    windowTitle: "Aya Dev",
    maxKeyboardProjects: 9,
    staleHostDetected: () => stale,
    confirmLosingWork: async (...args) => (log.push(["confirm", ...args]), true),
    ptyHost: { restart: async () => (log.push(["restart-host"]), true) },
    restartTerminals: async()=>{
      if(!await deps.confirmLosingWork("Restarting Aya Dev","Restart"))throw Error("restart cancelled");
      if(deps.staleHostDetected()&&!await deps.ptyHost.restart())throw Error("old host did not exit");
    },
    showAyaAboutPanel: () => log.push(["about"]),
    dispatchShortcut: (action) => log.push(["shortcut", action]),
    openNewWindow: async () => log.push(["new-window"]),
    focusedAyaWindow: () => focused,
    toggleAyaFullScreen: (win) => log.push(["fullscreen", win]),
    ...over,
  };
  const template = buildMenuTemplate(deps);
  const items = template.flatMap((menu) => menu.submenu);
  return {
    deps, template, items, log,
    click: (label) => items.find((item) => item.label === label).click(),
    setStale: (value) => { stale = value; },
    setFocused: (value) => { focused = value; },
  };
}

function describe(item) {
  return (item.label ?? `role:${item.role ?? item.type}`) +
    (item.accelerator ? ` [${item.accelerator}]` : "") +
    (item.id ? ` #${item.id}` : "");
}

for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform} menu keeps every item, role, separator and accelerator in order`, () => {
    const { template } = setup({ platform });
    const mac = platform === "darwin";
    const restart = "Restart Aya Dev #restart-aya";
    const expected = [
      ...(mac ? [["Aya Dev", [
        "About Aya Dev", "role:separator", "Settings... [CmdOrCtrl+,]", restart,
        "role:separator", "role:services", "role:separator", "role:hide", "role:hideOthers",
        "role:unhide", "role:separator", "role:quit",
      ]]] : []),
      ["File", [
        "New Shell [CmdOrCtrl+T]", "New Window [CmdOrCtrl+Shift+N]", "Close Terminal [CmdOrCtrl+W]",
        ...(mac ? [] : ["role:separator", restart]),
      ]],
      ["Edit", [
        "role:undo", "role:redo", "role:separator", "role:cut", "role:copy", "role:paste",
        "role:pasteAndMatchStyle", "role:delete", "role:selectAll",
      ]],
      ["View", [
        "Search [CmdOrCtrl+K]", "Find in Terminal [CmdOrCtrl+F]", "role:separator",
        "Previous Terminal [CmdOrCtrl+[]", "Next Terminal [CmdOrCtrl+]]", "role:separator",
        "Focus Pane Left [CmdOrCtrl+Alt+Left]", "Focus Pane Right [CmdOrCtrl+Alt+Right]",
        "Focus Pane Up [CmdOrCtrl+Alt+Up]", "Focus Pane Down [CmdOrCtrl+Alt+Down]",
        "Split Pane Right [CmdOrCtrl+Alt+\\]", "Split Pane Below [CmdOrCtrl+Alt+-]",
        "role:separator", "role:toggleDevTools", "role:separator", "role:resetZoom", "role:zoomIn",
        "role:zoomOut", "role:separator", `Toggle Full Screen [${mac ? "Ctrl+Command+F" : "F11"}]`,
      ]],
      ["Project", Array.from({ length: 9 }, (_, i) => `Select Project ${i + 1} [CmdOrCtrl+${i + 1}]`)],
      ["Window", ["role:minimize", "role:zoom", ...(mac
        ? ["role:separator", "role:front", "role:separator", "role:window"]
        : ["role:close"])]],
      ...(mac ? [] : [["Help", ["About Aya Dev"]]]),
    ];
    assert.deepEqual(template.map((menu) => [menu.label, menu.submenu.map(describe)]), expected);
  });
}

for (const platform of ["darwin", "linux"]) {
  test(`${platform} menu clicks dispatch every shortcut and window/About action`, () => {
    const s = setup({ platform });
    const shortcuts = [
      ...(platform === "darwin" ? [["Settings...", "open-settings"]] : []),
      ["New Shell", "new-shell"], ["Close Terminal", "close-tab"], ["Search", "search"],
      ["Find in Terminal", "find-in-pane"], ["Previous Terminal", "prev-tab"], ["Next Terminal", "next-tab"],
      ["Focus Pane Left", "focus-pane-left"], ["Focus Pane Right", "focus-pane-right"],
      ["Focus Pane Up", "focus-pane-up"], ["Focus Pane Down", "focus-pane-down"],
      ["Split Pane Right", "split-pane-right"], ["Split Pane Below", "split-pane-below"],
      ...Array.from({ length: 9 }, (_, i) => [`Select Project ${i + 1}`, `project-${i + 1}`]),
    ];
    for (const [label, action] of shortcuts) {
      s.click(label);
      assert.deepEqual(s.log.at(-1), ["shortcut", action], label);
    }
    s.click("About Aya Dev");
    assert.deepEqual(s.log.at(-1), ["about"]);
    assert.equal(s.click("New Window"), undefined);
    assert.deepEqual(s.log.at(-1), ["new-window"]);
    const current = { id: "second" };
    s.setFocused(current);
    s.click("Toggle Full Screen");
    assert.deepEqual(s.log.at(-1), ["fullscreen", current]);
    s.setFocused(null);
    s.click("Toggle Full Screen");
    assert.deepEqual(s.log.at(-1), ["fullscreen", null]);
    assert.equal(s.items.filter((item) => item.click).length, shortcuts.length + 4);
  });
}

test("install configures identity before building and setting the application menu", () => {
  const { deps, log } = setup();
  const menu = {};
  installApplicationMenu({
    ...deps,
    configureAppIdentity: () => log.push(["identity"]),
    Menu: {
      buildFromTemplate: (template) => {
        assert.equal(template[0].label, "Aya Dev");
        log.push(["build"]);
        return menu;
      },
      setApplicationMenu: (value) => { assert.equal(value, menu); log.push(["set"]); },
    },
  });
  assert.deepEqual(log, [["identity"], ["build"], ["set"]]);
});

test("a current host keeps its panes when Aya restarts", async () => {
  const s = setup();
  await s.click("Restart Aya Dev");
  assert.deepEqual(s.log, [["relaunch"], ["quit"]]);
});

test("a stale host asks and cancellation stops the restart", async () => {
  const s = setup();
  s.setStale(true);
  s.deps.confirmLosingWork = async (...args) => (s.log.push(["confirm", ...args]), false);
  await s.click("Restart Aya Dev");
  assert.deepEqual(s.log, [["confirm", "Restarting Aya Dev", "Restart"]]);
});

test("a confirmed stale host restart finishes before relaunch and quit", async () => {
  const s = setup();
  s.setStale(true);
  let finish;
  s.deps.ptyHost.restart = () => {
    s.log.push(["restart-host"]);
    return new Promise((resolve) => { finish = resolve; });
  };
  const clicked = s.click("Restart Aya Dev");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.log, [["confirm", "Restarting Aya Dev", "Restart"], ["restart-host"]]);
  finish(true);
  await clicked;
  assert.deepEqual(s.log.slice(-2), [["relaunch"], ["quit"]]);
});

test("confirmation errors keep Aya open without stopping an unapproved host", async () => {
  const s = setup();
  s.setStale(true);
  s.deps.confirmLosingWork = async () => { s.log.push(["confirm-error"]); throw new Error("gone"); };
  s.deps.ptyHost.restart = async () => { s.log.push(["restart-error"]); throw new Error("gone"); };
  await s.click("Restart Aya Dev");
  assert.deepEqual(s.log, [["confirm-error"]]);
});

test("the stale flag is read at click time and again after confirmation", async () => {
  const s = setup();
  s.setStale(true);
  s.deps.confirmLosingWork = async () => { s.setStale(false); return true; };
  await s.click("Restart Aya Dev");
  assert.deepEqual(s.log, [["relaunch"], ["quit"]]);
});

test("the red dot PNG preserves its original bytes and circle pixels", () => {
  const png = makeCirclePng(16, 255, 59, 48);
  // Captured from makeCirclePng before the move, including PNG framing and CRCs.
  assert.equal(createHash("sha256").update(png).digest("hex"),
    "ee8af7558fe13442f72fc69b47a10c0a3304006b50f64f3c4bcbfdb1747bad16");
  const small = makeCirclePng(4, 12, 34, 56);
  assert.equal(small.readUInt32BE(16), 4);
  assert.equal(small.readUInt32BE(20), 4);
  const idatLength = small.readUInt32BE(33);
  const rows = inflateSync(small.subarray(41, 41 + idatLength));
  assert.deepEqual([...rows], [
    0, 12, 34, 56, 0, 12, 34, 56, 0, 12, 34, 56, 0, 12, 34, 56, 0,
    0, 12, 34, 56, 0, 12, 34, 56, 255, 12, 34, 56, 255, 12, 34, 56, 0,
    0, 12, 34, 56, 0, 12, 34, 56, 255, 12, 34, 56, 255, 12, 34, 56, 0,
    0, 12, 34, 56, 0, 12, 34, 56, 0, 12, 34, 56, 0, 12, 34, 56, 0,
  ]);
});

test("the stale menu icon is a 16px red PNG at scale factor 2", () => {
  const item = {};
  const icon = {};
  const log = [];
  setStaleMenuIcon({
    Menu: { getApplicationMenu: () => ({ getMenuItemById: (id) => (log.push(id), item) }) },
    nativeImage: { createFromBuffer: (buffer, options) => {
      assert.deepEqual(buffer, makeCirclePng(16, 255, 59, 48));
      assert.deepEqual(options, { scaleFactor: 2 });
      return icon;
    } },
  });
  assert.deepEqual(log, ["restart-aya"]);
  assert.equal(item.icon, icon);
});

test("the stale icon is a no-op before installation or when the restart item is absent", () => {
  for (const menu of [null, { getMenuItemById: () => null }]) {
    setStaleMenuIcon({
      Menu: { getApplicationMenu: () => menu },
      nativeImage: { createFromBuffer: () => assert.fail("no image without an item") },
    });
  }
});
