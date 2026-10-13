// Project IPC (electron/ipc/projects-ipc.ts) against a temp AYA_HOME: what a window reads and saves goes through
// its slice; without a window (Aya Web, remote) the whole state does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "aya-projects-ipc-"));
process.env.AYA_HOME = join(HOME, ".aya");
const { registerProjectsIpc } = await import("../dist-electron/ipc/projects-ipc.js");

test.after(() => rmSync(HOME, { recursive: true, force: true }));

function setup() {
  const handlers = new Map();
  const seen = { slices: [], merges: [] };
  registerProjectsIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    senderWindow: (e) => e.win ?? null,
    stateForWindow: (state, windowId) => (seen.slices.push(windowId), { ...state, sliceOf: windowId }),
    mergeSave: (state, windowId, disk) => (seen.merges.push({ windowId, disk }), state),
  });
  return { handlers, seen, call: (channel, e = {}, ...args) => handlers.get(channel)(e, ...args) };
}

test("registers exactly the project channels", () => {
  assert.deepEqual([...setup().handlers.keys()].sort(), [
    "projects:create",
    "projects:create-remote",
    "projects:list",
    "projects:read-repo-config",
    "projects:save-state",
    "projects:state",
    "projects:update",
  ]);
});

test("a created project is listed; a window reads its slice, no window the whole state", async () => {
  const dir = join(HOME, "work");
  mkdirSync(dir);
  const { call, seen } = setup();
  const project = await call("projects:create", {}, "Work", dir);
  assert.equal(project.directory, dir);
  assert.ok((await call("projects:list")).some((p) => p.slug === project.slug));
  const whole = await call("projects:state", {});
  assert.equal(whole.sliceOf, undefined);
  const slice = await call("projects:state", { win: { id: 4 } });
  assert.equal(slice.sliceOf, 4);
  assert.deepEqual(seen.slices, [4]);
});

test("a window's save is merged with the state on disk; no window saves as given", async () => {
  const { call, seen } = setup();
  const state = { order: [], open: [], recent: [] };
  await call("projects:save-state", { win: { id: 5 } }, state);
  assert.equal(seen.merges.length, 1);
  assert.equal(seen.merges[0].windowId, 5);
  assert.ok(seen.merges[0].disk && Array.isArray(seen.merges[0].disk.open), "the disk state was read");
  await call("projects:save-state", {}, state);
  assert.equal(seen.merges.length, 1);
  await assert.rejects(call("projects:save-state", {}, "nope"));
});

test("a repo without .aya/project.json has no repo config; bad arguments are refused", async () => {
  const { call } = setup();
  assert.equal(await call("projects:read-repo-config", {}, HOME), null);
  await assert.rejects(call("projects:create", {}, "x", 7), /projects:create\.dir/);
  await assert.rejects(call("projects:create-remote", {}, []), /must be an object/);
});
