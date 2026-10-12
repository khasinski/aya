// aya notify puts an agent's words in a system notification: the title and body arrive as one plain line, so a bidi
// override cannot reorder what the user reads there and a control character cannot break it. Electron's
// Notification is replaced by a recorder; the request goes through the real CLI and control server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { envWithoutAya } from "./helpers/env.mjs";
import { waitFor } from "./helpers/wait-for.mjs";

const require = createRequire(import.meta.url);
const CONTROL = join(process.cwd(), "dist-electron", "control.js");
const electronId = createRequire(CONTROL).resolve("electron");
const shown = [];
const saved = require.cache[electronId];
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: {
    Notification: class {
      static isSupported() {
        return true;
      }
      constructor(options) {
        this.options = options;
      }
      on() {}
      show() {
        shown.push(this.options);
      }
    },
  },
};
const { startControlServerOn } = await import(CONTROL);

const C = (n) => String.fromCharCode(n);
const root = mkdtempSync(join(tmpdir(), "aya-notify-"));
const socket = join(root, "aya.sock");
const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {} });
test.after(() => {
  stop();
  if (saved) require.cache[electronId] = saved;
  else delete require.cache[electronId];
  rmSync(root, { recursive: true, force: true });
});

function notify(...args) {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [resolve("bin/aya"), "notify", ...args], { cwd: root, env: { ...envWithoutAya(), HOME: root, AYA_SOCKET: socket } });
    child.on("error", fail);
    child.on("close", (status) => done(status));
  });
}

test("the title and body of aya notify reach the notification as one plain line", async () => {
  // A bidi override and its pop, a control character, and a line break in each.
  const title = `build ${C(0x202e)}gnissap${C(0x202c)} done`;
  const body = `tests \x1b]0;owned\x07 pass\nnext line`;
  assert.equal(await notify("--title", title, body), 0);
  await waitFor(() => shown.length === 1);
  assert.deepEqual(shown[0], { title: "build gnissap done", body: "tests  ]0;owned  pass next line", silent: false });
});

test("a title that is nothing once cleaned falls back to Aya", async () => {
  shown.length = 0;
  assert.equal(await notify("--title", `${C(0x202e)}${C(0x200f)}`, "body"), 0);
  await waitFor(() => shown.length === 1);
  assert.equal(shown[0].title, "Aya");
});
