// Two config-watcher bugs, with native folder events silenced so only the polling backup can see changes (the case it
// exists for): a project config created after the start was never reported, and a project config deleted and then
// restored with the same bytes (a git checkout) read as the app's own save, so the project stayed dropped. Real
// timers; waiting on conditions only. AYA_HOME points at a temp dir before any Aya module loads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers/wait-for.mjs";

// The CommonJS fs object the compiled watcher calls watch on (an ESM namespace cannot be mocked).
const nodeFs = createRequire(import.meta.url)("node:fs");
const home = mkdtempSync(join(tmpdir(), "aya-config-restore-"));
process.env.AYA_HOME = home;
const projects = join(home, "projects");

const { startConfigWatcher } = await import("../dist-electron/config-watcher.js");
const { writeFileAtomic } = await import("../dist-electron/atomic-write.js");
test.after(() => rmSync(home, { recursive: true, force: true }));

/** The watcher on a fake window, with fs.watch made silent: what it sent, and a stop. */
function startPollingOnly(t) {
  t.mock.method(nodeFs, "watch", () => Object.assign(new EventEmitter(), { close() {} }));
  const received = [];
  const win = { isDestroyed: () => false, webContents: { send: (_channel, payload) => received.push(payload.slice) } };
  const stop = startConfigWatcher(win);
  t.after(stop);
  return received;
}

// Two polls of 500 ms: by then the first scan, which only learns what is on disk, is done.
const pastBaseline = () => new Promise((r) => setTimeout(r, 1200));

test("a project config created after the start is reported by polling", async (t) => {
  const received = startPollingOnly(t);
  await pastBaseline();
  writeFileSync(join(projects, "epsilon.json"), JSON.stringify({ name: "epsilon" }));
  await waitFor(() => received.includes("projects"), 15000);
});

test("a project config deleted and restored with the same bytes is reported both times", async (t) => {
  const file = join(projects, "delta.json");
  const content = JSON.stringify({ name: "delta" });
  // The app's own save: what the watcher must not report.
  await writeFileAtomic(file, content);
  const received = startPollingOnly(t);
  await pastBaseline();
  assert.deepEqual(received, [], "the app's own save is not a change");
  rmSync(file);
  await waitFor(() => received.length === 1, 15000);
  writeFileSync(file, content);
  await waitFor(() => received.length === 2, 15000);
  assert.deepEqual(received, ["projects", "projects"]);
});
