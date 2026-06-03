// End-to-end behavior of the config-file watcher: it watches
// AYA_HOME for EXTERNAL edits to snippets/presets/themes.json and tells the
// renderer to reload that slice, while ignoring the echo of Aya's own
// writeFileAtomic saves so an in-app save doesn't reload-storm.
//
// IMPORTANT: only Node built-ins are statically imported here. config-watcher
// (and atomic-write, which it shares the echo registry with) are imported
// DYNAMICALLY *after* AYA_HOME is pointed at a temp dir — a static import would
// be hoisted and freeze paths.ts to the real ~/.aya before we could redirect
// it. `node --test` runs each test file in its own process, so this redirect
// can't leak into the other suites.
//
// These exercise the real fs.watch path against a throwaway AYA_HOME, so they
// use real timers and wait out the 200ms WATCH_DEBOUNCE_MS (see waitForDebounce)
// before asserting — there's no fake-timer infra in this repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WATCH_DEBOUNCE_MS is 200; give the coalescing burst of raw fs events plus the
// debounce comfortable headroom before we read `received`.
const SETTLE_MS = 320;
const waitForDebounce = () => new Promise((r) => setTimeout(r, SETTLE_MS));

// Distinct JSON payloads so each write is byte-different from the last (the
// watcher reads + hashes content, so same-bytes writes wouldn't be a real edit).
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

    // (a) An external write of new bytes → exactly one reload of that slice.
    writeFileSync(file, SNIPPETS_A);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [{ slice: "snippets" }],
      "an external edit reloads exactly the snippets slice once",
    );

    // (b) Aya's OWN save (writeFileAtomic records the echo hash) → no reload.
    // This is the core anti-reload-storm guarantee.
    received.length = 0;
    await writeFileAtomic(file, SNIPPETS_B);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [],
      "an in-app save is recognized as an echo and does not reload",
    );

    // (c) THE DRIFT BUG. Aya last wrote SNIPPETS_B above,
    // so SNIPPETS_B is "the bytes Aya previously wrote". Make a genuine external
    // edit to SNIPPETS_A first (which the watcher must emit AND re-baseline to),
    // then revert the file on disk back to SNIPPETS_B. Reverting to Aya's prior
    // bytes used to re-match the stale echo baseline, get mis-read as an echo,
    // be swallowed, and then be clobbered by the next save. With the fix the
    // watcher re-baselines to whatever it last told the renderer to load, so the
    // revert is a real change vs that baseline and MUST still emit.
    received.length = 0;
    writeFileSync(file, SNIPPETS_A);
    await waitForDebounce();
    assert.deepEqual(
      received,
      [{ slice: "snippets" }],
      "the external edit before the revert reloads once (and re-baselines)",
    );

    received.length = 0;
    writeFileSync(file, SNIPPETS_B); // revert to the exact bytes Aya last wrote
    await waitForDebounce();
    assert.deepEqual(
      received,
      [{ slice: "snippets" }],
      "reverting to Aya's previously-written bytes is still an external edit, " +
        "not a swallowed echo (the bug the source fix addresses)",
    );

    // (d) After stop() the watcher is closed and its timers cleared, so a
    // further external write produces no more reloads.
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
