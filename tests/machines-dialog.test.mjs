// The native dialogs that are the user's yes for aya machines add and remove, with
// Electron's dialog replaced by a recorder: Cancel must be the default and the
// Escape answer, only the action button may say yes, and a destroyed window must
// not take the dialog down with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MODULE = join(process.cwd(), "dist-electron", "machines-dialog.js");
const electronId = createRequire(MODULE).resolve("electron");
const { addDialogText, ayaMachinesDeps, confirmAddInAya, confirmRemoveInAya } = await import(MODULE);

/** Electron as the module sees it: a dialog that records each call and answers `response`. */
function fakeElectron(t, response) {
  const calls = [];
  const saved = require.cache[electronId];
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      dialog: {
        showMessageBox: async (...args) => {
          calls.push(args);
          return { response };
        },
      },
    },
  };
  t.after(() => {
    if (saved) require.cache[electronId] = saved;
    else delete require.cache[electronId];
  });
  return calls;
}
const ASK = {
  pane: "collector",
  machines: [{ id: "athena", reach: { ssh: "athena" }, port: 11434, status: { reachable: false, error: "timeout", gpus: [], ollama: { up: false, loaded: null } } }],
};
const liveWindow = () => ({ isDestroyed: () => false });

test("Add: only the Add button is a yes; Cancel is the default and the Escape answer", async (t) => {
  const win = liveWindow();
  const signal = new AbortController().signal;
  const calls = fakeElectron(t, 0);
  assert.equal(await confirmAddInAya(ASK, win, signal), true);
  const [parent, options] = calls[0];
  assert.equal(parent, win, "the dialog is attached to Aya's window");
  assert.deepEqual(options.buttons, ["Add", "Cancel"]);
  assert.equal(options.defaultId, 1);
  assert.equal(options.cancelId, 1);
  assert.equal(options.noLink, true);
  assert.equal(options.signal, signal, "the caller can close the dialog");
  assert.equal(options.message, "Add athena to Aya's machines?");
  // The wording itself is pinned in machines-registry.test.mjs; here, that the dialog shows it.
  assert.deepEqual({ message: options.message, detail: options.detail }, addDialogText(ASK));
});

test("Add: Cancel, or any answer but the Add button, is a no", async (t) => {
  for (const response of [1, 2, -1]) {
    const calls = fakeElectron(t, response);
    assert.equal(await confirmAddInAya(ASK, liveWindow()), false, `response ${response}`);
    assert.equal(calls.length, 1);
  }
});

test("with no window, or a destroyed one, the dialog still asks, without a parent", async (t) => {
  for (const win of [null, { isDestroyed: () => true }]) {
    const calls = fakeElectron(t, 0);
    assert.equal(await confirmAddInAya(ASK, win), true);
    assert.equal(await confirmRemoveInAya("athena", win), true);
    assert.equal(calls.length, 2);
    for (const args of calls) {
      assert.equal(args.length, 1, "showMessageBox(options), no parent window");
      assert.equal(args[0].cancelId, 1);
    }
  }
});

test("Remove: the button names the action, Cancel is the default, and the text says nothing changes on the machine", async (t) => {
  const win = liveWindow();
  const calls = fakeElectron(t, 1);
  assert.equal(await confirmRemoveInAya("athena", win), false);
  const [parent, options] = calls[0];
  assert.equal(parent, win);
  assert.deepEqual(options.buttons, ["Remove", "Cancel"]);
  assert.deepEqual([options.defaultId, options.cancelId], [1, 1]);
  assert.equal(options.message, "Remove athena from Aya's machines?");
  assert.equal(options.detail, "Aya stops reading its state; nothing changes on the machine.");
  fakeElectron(t, 0);
  assert.equal(await confirmRemoveInAya("athena", win), true);
});

test("ayaMachinesDeps: remote projects only, and each dialog asks over the window open at that moment", async (t) => {
  let current = null;
  const projects = [
    { name: "local one", slug: "a", directory: "/a", tabs: [] },
    { name: "gpu box", slug: "b", directory: "/b", tabs: [], remote: { sshTarget: "athena", directory: "/srv" } },
  ];
  const deps = ayaMachinesDeps("/aya-home", "/user-home", () => current, async () => projects);
  assert.deepEqual([deps.ayaHome, deps.userHome], ["/aya-home", "/user-home"]);
  assert.deepEqual(await deps.listRemoteProjects(), [{ name: "gpu box", sshTarget: "athena" }]);
  assert.deepEqual(await ayaMachinesDeps("/h", "/u", () => null).listRemoteProjects(), [], "no project list: no remote projects");

  const calls = fakeElectron(t, 0);
  current = liveWindow();
  assert.equal(await deps.confirmAdd(ASK), true);
  assert.equal(await deps.confirmRemove("athena"), true);
  assert.equal(calls[0][0], current, "Add asked over the window open now, not at setup");
  assert.equal(calls[1][0], current);
  assert.equal(calls[1][1].message, "Remove athena from Aya's machines?");
});
