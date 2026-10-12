// More of the config watcher, with real timers this time: the projects/ folder
// (edits, the app's own saves, deletes, the whole folder going away and coming
// back), a deleted top-level config that must NOT reload, a closed window that
// gets nothing, and a start that fails when AYA_HOME is not a folder.
// tests/config-watcher.test.mjs covers the top-level slices with a virtual clock.
//
// As there, only Node built-ins are imported at the top: config-watcher and
// atomic-write are imported after AYA_HOME points at a temp dir, so paths.ts
// never sees the real ~/.aya. Each test file runs in its own process.
//
// Waiting is by condition, never by a fixed sleep. The watcher polls every
// 500 ms besides the native fs.watch events, and every poll lists projects/
// once, so counting finished readdir calls tells how many polls have looked at
// the disk. A "nothing was sent" check waits for three more polls (over a
// second, well past the 200 ms debounce of the native path) with no fs read
// still in flight.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./helpers/wait-for.mjs";

const home = mkdtempSync(join(tmpdir(), "aya-config-watcher-more-"));
process.env.AYA_HOME = home;
const projectsDir = join(home, "projects");

// Registered before the imports, so a failing import leaves no temp dir behind.
test.after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.AYA_HOME;
});

const { startConfigWatcher } = await import("../dist-electron/config-watcher.js");
const { writeFileAtomic } = await import("../dist-electron/atomic-write.js");

let version = 0;
// A project config with content no earlier write in this file had.
const freshProject = () => JSON.stringify({ name: "alpha", v: ++version });

/** Start the watcher on a fake window and return what it sent plus a way to
 *  wait until it has polled the disk `polls` more times with nothing in flight. */
async function startWatched(t, { destroyed = false } = {}) {
  const received = [];
  const win = {
    destroyedChecks: 0,
    isDestroyed() {
      this.destroyedChecks++;
      return destroyed;
    },
    webContents: {
      send: (channel, payload) => received.push({ channel, ...payload }),
    },
  };

  const pending = new Set();
  let pollsDone = 0;
  for (const name of ["readFile", "readdir"]) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => {
      const work = original(...args);
      pending.add(work);
      const done = () => {
        pending.delete(work);
        if (name === "readdir") pollsDone++;
      };
      work.then(done, done);
      return work;
    });
  }
  const settle = async (polls = 3) => {
    const target = pollsDone + polls;
    await waitFor(() => pollsDone >= target && pending.size === 0, 15000);
  };

  const stop = startConfigWatcher(win);
  t.after(stop);
  // The first poll only records what is on disk. FSEvents (macOS) can also
  // report the files a test wrote just before the watch began, so let those
  // late events play out and count changes from a quiet start.
  await waitFor(() => pollsDone >= 1 && pending.size === 0, 15000);
  // Quiet means three polls with nothing sent; a late event restarts the count (up to five rounds).
  for (let round = 0; round < 5; round += 1) {
    received.length = 0;
    await settle();
    if (received.length === 0) break;
  }
  received.length = 0;
  win.destroyedChecks = 0;
  return { received, win, settle };
}

test("an outside edit to a project config reloads the projects slice, other files in projects/ do not", async (t) => {
  const alpha = join(projectsDir, "alpha.json");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(alpha, freshProject());
  const { received, settle } = await startWatched(t);

  // Not project configs: a dotfile (editor swap file) and a non-JSON file.
  writeFileSync(join(projectsDir, ".alpha.json"), "{}");
  writeFileSync(join(projectsDir, "notes.txt"), "hello");
  await settle();
  assert.deepEqual(received, [], "dotfiles and non-JSON files in projects/ reload nothing");

  writeFileSync(alpha, freshProject());
  await waitFor(() => received.length > 0, 15000);
  await settle();
  assert.ok(
    received.every((r) => r.channel === "config:changed" && r.slice === "projects"),
    `an edit to projects/alpha.json reloads only the projects slice: ${JSON.stringify(received)}`,
  );
});

test("a project config saved by the app itself is not reported", async (t) => {
  const alpha = join(projectsDir, "alpha.json");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(alpha, freshProject());
  const { received, settle } = await startWatched(t);

  await writeFileAtomic(alpha, freshProject());
  await settle();
  assert.deepEqual(received, [], "the app's own save to a project config is an echo, not an edit");
});

test("deleting a project config from outside reloads the projects slice", async (t) => {
  const beta = join(projectsDir, "beta.json");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(beta, freshProject());
  const { received } = await startWatched(t);

  rmSync(beta);
  await waitFor(() => received.some((r) => r.slice === "projects"), 15000);
  assert.ok(
    received.every((r) => r.slice === "projects"),
    `a deleted project config reloads only the projects slice: ${JSON.stringify(received)}`,
  );
});

test("deleting snippets.json from outside reloads nothing (the next save writes it back)", async (t) => {
  const snippets = join(home, "snippets.json");
  writeFileSync(snippets, '{"snippets":[]}');
  const { received, settle } = await startWatched(t);

  rmSync(snippets);
  await settle();
  assert.deepEqual(received, [], "a missing top-level config is not a reload");
});

test("when the projects folder is deleted its configs drop off, and polling finds configs again once it is back", async (t) => {
  const gamma = join(projectsDir, "gamma.json");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(gamma, freshProject());
  const { received, settle } = await startWatched(t);

  rmSync(projectsDir, { recursive: true, force: true });
  await waitFor(() => received.some((r) => r.slice === "projects"), 15000);
  // Polls go on with projects/ gone: the failed listing must not stop them.
  await settle();

  received.length = 0;
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(gamma, freshProject());
  await waitFor(() => received.some((r) => r.slice === "projects"), 15000);
  assert.ok(
    received.every((r) => r.slice === "projects"),
    `a project config written into the recreated folder reloads projects: ${JSON.stringify(received)}`,
  );
});

test("a window that is already closed is sent nothing", async (t) => {
  const presets = join(home, "presets.json");
  writeFileSync(presets, '{"presets":[]}');
  const { received, win, settle } = await startWatched(t, { destroyed: true });

  writeFileSync(presets, '{"presets":[{"id":"p"}]}');
  // The watcher saw the edit once it asked whether the window is still open
  // (or once it sent something it should not have).
  await waitFor(() => win.destroyedChecks > 0 || received.length > 0, 15000);
  await settle();
  assert.deepEqual(received, [], "nothing is sent to a destroyed window");
});

// Last: it replaces AYA_HOME with a plain file.
test("when AYA_HOME is not a folder the watcher starts nothing and its stop still works", (t) => {
  rmSync(home, { recursive: true, force: true });
  writeFileSync(home, "not a folder");
  const reads = t.mock.method(fs, "readFile");
  const win = {
    isDestroyed: () => false,
    webContents: { send: () => assert.fail("nothing should be sent") },
  };

  let stop;
  assert.doesNotThrow(() => {
    stop = startConfigWatcher(win);
  }, "a failed start does not throw into the app");
  // A started watcher reads the config files at once, in the first poll.
  assert.equal(reads.mock.callCount(), 0, "no poll was started");
  assert.doesNotThrow(() => stop(), "stop() of a watcher that never started is a no-op");
});
