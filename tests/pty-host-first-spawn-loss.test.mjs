import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateHome } from "./helpers/isolate-home.mjs";
const root = fs.mkdtempSync(path.resolve("test-results/first-spawn-"));
isolateHome(root); process.env.SHELL = "/bin/sh";
fs.mkdirSync(process.env.HOME, { recursive: true }); fs.mkdirSync(process.env.AYA_HOME, { recursive: true });
const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");
const { cleanupNativeOwner } = await import("./helpers/pty-host.mjs");

test("the first owner spawn survives a host death before its response and is reported disconnected", { timeout: 15000 }, async () => {
  const events = [], client = new PtyHostClient(path.resolve("tests/helpers/pty-host-die-before-spawn-reply.cjs"));
  client.attachWebContents({ isDestroyed: () => false, send: (_channel, event) => events.push(event) });
  try {
    await assert.rejects(client.spawn({ ptyId: "first", command: "/bin/sleep 60", cwd: root, cols: 80, rows: 24 }), /PTY host disconnected/);
    const { pid } = JSON.parse(fs.readFileSync(path.join(process.env.AYA_HOME, "lost-first-spawn.json")));
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.deepEqual(events.filter(e => e.ptyId === "first").map(e => e.type), ["disconnected"]);
    const record = JSON.parse(fs.readFileSync(path.join(process.env.AYA_HOME, "pty-owner/record.json")));
    assert.equal(record.panes[0].pid, pid);
  } finally { client.dispose(); await cleanupNativeOwner(process.env.AYA_HOME); fs.rmSync(root, { recursive: true, force: true }); }
});
