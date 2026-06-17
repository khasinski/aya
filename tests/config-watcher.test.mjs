// Tests the config-file watcher end to end: it watches AYA_HOME for edits made
// to snippets/presets/themes.json from outside the app and tells the renderer
// to reload that slice, while ignoring the app's own saves so a normal save
// doesn't trigger a reload.
//
// IMPORTANT: only Node built-ins are imported at the top here. config-watcher
// (and atomic-write, which shares its record of recent writes) are imported
// dynamically *after* AYA_HOME is pointed at a temp dir. A normal top-level
// import would run first and lock paths.ts to the real ~/.aya before we could
// redirect it. `node --test` runs each test file in its own process, so this
// redirect can't leak into the other test files.
//
// These run against a throwaway AYA_HOME using the real fs.watch, so they use
// real timers and wait out the 200ms WATCH_DEBOUNCE_MS (see waitForDebounce)
// before checking results; there's no fake-timer setup in this repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WATCH_DEBOUNCE_MS is 200; leave enough margin for the burst of file events
// plus the debounce before we read `received`. Under the full test suite macOS
// fs.watch can deliver the event noticeably later than when this file runs alone.
const SETTLE_MS = 1000;
const waitForDebounce = () => new Promise((r) => setTimeout(r, SETTLE_MS));

// Two different JSON payloads so each write differs from the last (the watcher
// reads and hashes the content, so writing the same bytes wouldn't count as an
// edit).
const SNIPPETS_A = '{"snippets":[{"id":"a","name":"a","text":"echo a"}]}';
const SNIPPETS_B = '{"snippets":[{"id":"b","name":"b","text":"echo b"}]}';

test("config watcher emits external edits, skips echoes, catches reverts, and stops cleanly", async () => {
  const home = mkdtempSync(join(tmpdir(), "aya-config-watcher-"));
  process.env.AYA_HOME = home;

  const received = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, payload) => received.push(payload),
    },
  };

  let stop = () => {};
  try {
    const { startConfigWatcher } = await import(
      "../dist-electron/config-watcher.js"
    );
    const { writeFileAtomic } = await import("../dist-electron/atomic-write.js");

    const file = join(home, "snippets.json");
    stop = startConfigWatcher(win);

    // (a) An outside write of new content -> exactly one reload of that slice.
    writeFileSync(file, SNIPPETS_A);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [{ slice: "snippets" }],
      "an outside edit reloads exactly the snippets slice once",
    );

    // (b) Aya's OWN save (writeFileAtomic records the hash) -> no reload.
    // This is the main thing that stops saves from causing reloads.
    received.length = 0;
    await writeFileAtomic(file, SNIPPETS_B);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [],
      "a save by the app is recognized as our own and does not reload",
    );

    // (c) THE DRIFT BUG. Aya last wrote SNIPPETS_B above, so SNIPPETS_B is "what
    // Aya wrote last". First make a real outside edit to SNIPPETS_A (the watcher
    // must report it AND update its stored hash to it), then change the file on
    // disk back to SNIPPETS_B. Going back to what Aya wrote before used to match
    // the old stored hash, look like our own save, get ignored, and then get
    // overwritten by the next save. With the fix the watcher updates its stored
    // hash to whatever it last told the renderer to load, so going back is a real
    // change against that hash and must still be reported.
    received.length = 0;
    writeFileSync(file, SNIPPETS_A);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [{ slice: "snippets" }],
      "the outside edit before the revert reloads once (and updates the stored hash)",
    );

    received.length = 0;
    writeFileSync(file, SNIPPETS_B); // change back to the exact content Aya wrote last
    await waitForDebounce();
    assert.deepEqual(
      received,
      [{ slice: "snippets" }],
      "going back to what Aya wrote before is still an outside edit, " +
        "not ignored as our own save (the bug the source fix addresses)",
    );

    // (d) After stop() the watcher is closed and its timers cleared, so another
    // outside write produces no more reloads.
    stop();
    stop = () => {};
    received.length = 0;
    writeFileSync(file, SNIPPETS_A);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [],
      "no reloads after stop() closes the watcher",
    );
  } finally {
    stop();
    rmSync(home, { recursive: true, force: true });
    delete process.env.AYA_HOME;
  }
});
