// aya notify puts an agent's words in a system notification: the title and body are shown as text (printable.ts), so
// a bidi override cannot reorder what the user reads there and a control character cannot act; emoji and line
// breaks stay. Electron's
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

const C = (n) => String.fromCodePoint(n);
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

test("the title and body of aya notify reach the notification as text: each acting character as its escape", async () => {
  // A bidi override and its pop in the title; an OSC sequence, a line break and a ZWJ emoji in the body.
  const family = `${C(0x1f469)}${C(0x200d)}${C(0x1f467)}`;
  const title = `build ${C(0x202e)}gnissap${C(0x202c)} done`;
  const body = `tests \x1b]0;owned\x07 pass\n${family} next line`;
  assert.equal(await notify("--title", title, body), 0);
  await waitFor(() => shown.length === 1);
  assert.deepEqual(shown[0], {
    title: "build \\u202egnissap\\u202c done",
    body: `tests \\u001b]0;owned\\u0007 pass\n${family} next line`,
    silent: false,
  });
});

test("with no title the notification is titled Aya", async () => {
  shown.length = 0;
  assert.equal(await notify("body"), 0);
  await waitFor(() => shown.length === 1);
  assert.equal(shown[0].title, "Aya");
});
