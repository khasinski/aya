// Every channel the window invokes (preload) or Aya Web forwards (src/web/bridge.ts) has exactly one handler in
// electron/, and every handler is invoked by one of them. The IPC handlers live in several modules (electron/ipc/,
// main.ts): a channel lost or registered twice in a move fails here, not in a window at run time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

/** Channels a file registers: handle("x") / on("x"), and `p:${v}` handled inside `for (const v of [...])`. */
function registered(text) {
  const channels = [...text.matchAll(/\.(?:handle|on)\(\s*"([a-z][a-z0-9-]*:[a-z0-9:-]+)"/g)].map((m) => m[1]);
  for (const loop of text.matchAll(/for \(const (\w+) of \[([^\]]*)\]/g)) {
    const [, name, list] = loop;
    const body = text.slice(loop.index, loop.index + 600);
    if (!body.includes(".handle(")) continue;
    const values = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const tpl of body.matchAll(new RegExp("`([a-z][a-z0-9-]*:)\\$\\{" + name + "\\}([^`]*)`", "g"))) {
      for (const value of values) channels.push(`${tpl[1]}${value}${tpl[2]}`);
    }
  }
  return channels;
}

const invokedByWindow = new Set(
  [...readFileSync(join(ROOT, "electron/preload.ts"), "utf8").matchAll(/ipcRenderer\.(?:invoke|send)\(\s*"([^"]+)"/g)].map((m) => m[1]),
);
const invokedByWeb = new Set([...readFileSync(join(ROOT, "src/web/bridge.ts"), "utf8").matchAll(/\binv\(\s*"([^"]+)"/g)].map((m) => m[1]));

const counts = new Map();
for (const file of sources(join(ROOT, "electron"))) {
  if (file.endsWith("preload.ts")) continue;
  for (const channel of registered(readFileSync(file, "utf8"))) {
    if (!channel.includes(":") && !["open-project:done"].includes(channel)) continue;
    counts.set(channel, [...(counts.get(channel) ?? []), file.slice(ROOT.length + 1)]);
  }
}

test("every channel the window or Aya Web invokes has a handler", () => {
  const missing = [...new Set([...invokedByWindow, ...invokedByWeb])].filter((channel) => !counts.has(channel)).sort();
  assert.deepEqual(missing, []);
});

test("no channel is registered twice", () => {
  const twice = [...counts].filter(([, files]) => files.length > 1).map(([channel, files]) => `${channel}: ${files.join(", ")}`);
  assert.deepEqual(twice, []);
});

test("every registered channel is invoked by the window or Aya Web", () => {
  const unused = [...counts.keys()].filter((channel) => !invokedByWindow.has(channel) && !invokedByWeb.has(channel)).sort();
  assert.deepEqual(unused, []);
});

test("the scan sees the handlers: a known channel of each kind is found", () => {
  for (const channel of ["pty:spawn", "env:git", "web:status", "teams:pause", "open-project:done"]) {
    assert.ok(counts.has(channel), channel);
  }
});

test("main.ts registers every IPC module, so the handlers the scan sees are also there at run time", () => {
  const main = readFileSync(join(ROOT, "electron/main.ts"), "utf8");
  const modules = readdirSync(join(ROOT, "electron/ipc")).filter((name) => name.endsWith(".ts"));
  assert.ok(modules.length >= 9, "the ipc modules are found");
  const notCalled = [];
  for (const name of modules.map((m) => join("ipc", m))) {
    const text = readFileSync(join(ROOT, "electron", name), "utf8");
    for (const [, register] of text.matchAll(/export function (register\w*Ipc)\(/g)) {
      if (!new RegExp(`\\b${register}\\(`).test(main)) notCalled.push(`${register} (${name})`);
    }
  }
  assert.deepEqual(notCalled, []);
});
