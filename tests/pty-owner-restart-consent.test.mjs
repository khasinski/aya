import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { currentProcessesConfirmed, confirmRestart } from "../dist-electron/relaunch-notes.js";
test("forced owner migration honors same-process consent and cannot vouch for an unrecorded process", async () => {
  fs.mkdirSync("test-results", { recursive: true }); const dir = fs.mkdtempSync(path.resolve("test-results/consent-"));
  try {
    const file = path.join(dir, "notes.json"), pids = { a: 101, b: 102 };
    const deps = { file, panes: async () => [{ id: "a" }, { id: "b" }], pid: async id => pids[id] };
    assert.equal(await currentProcessesConfirmed(deps, 2), false);
    fs.writeFileSync(file, JSON.stringify({ a: { pid: 101, quiet: true }, b: { pid: 102, quiet: true } }));
    assert.equal(await currentProcessesConfirmed(deps, 2), true);
    assert.equal(await currentProcessesConfirmed(deps, 3), false);
    pids.b = 103; assert.equal(await currentProcessesConfirmed(deps, 2), false);
    pids.b = undefined; assert.equal(await currentProcessesConfirmed(deps, 2), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("a disconnected retained process asks before a pane restart even without readable VT", async () => {
  fs.mkdirSync("test-results", { recursive: true }); const dir = fs.mkdtempSync(path.resolve("test-results/consent-"));
  try {
    const file = path.join(dir, "notes.json"), asked = [];
    const deps = { file, panes: async () => [{ id: "a", name: "Agent" }], pid: async () => 101,
      disconnected: async () => true, screen: async () => null };
    assert.equal(await confirmRestart(deps, "Restarting this terminal", async text => { asked.push(text); return false; }), false);
    assert.equal(asked.length, 1); assert.match(asked[0], /disconnected/); assert.equal(fs.existsSync(file), false);
    assert.equal(await confirmRestart(deps, "Restarting this terminal", async () => true), true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).a.quiet, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
