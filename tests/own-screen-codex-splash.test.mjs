// codex-cli 0.159.3 draws its composer under its start-up splash ~0.35 s before a trust or update dialog, so
// there its composer counts only once the screen has settled. codex-idle is cut before its update dialog.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ownScreen, holdsOver } from "./helpers/own-screen.mjs";

const { openVtPane, closeVtPane, writeVtPane, paneHold, SCREEN_SETTLE_MS, SCREEN_SETTLE_MAX_MS } = await import("../dist-electron/vt-state.js");
const { HOLD_STARTING, HOLD_CHOICE } = await import("../dist-electron/pane-holds.js");

const SPLASH = /[⠀-⣿]{8,}/;
// The update dialog arrives at 668 ms.
const { meta, reads } = ownScreen("codex-idle");
const PREFIX = reads.filter(([t]) => t < 600);
const LAST = PREFIX.at(-1)[0];

/** paneHold at each time (ms after the spawn) on a fake clock: the prefix, then `more(t)` writes, if any. */
async function holdsAfterPrefix(times, more = () => null) {
  const realNow = Date.now;
  let now = 5_000_000;
  const start = now;
  Date.now = () => now;
  const id = `splash-${Math.random()}`;
  try {
    openVtPane(id, meta.cols, meta.rows, () => {}, "codex");
    for (const [t, text] of PREFIX) {
      now = start + t;
      writeVtPane(id, text);
    }
    const out = [];
    let at = LAST;
    for (const t of times) {
      for (; at + 200 <= t; at += 200) {
        const frame = more(at + 200);
        now = start + at + 200;
        if (frame) writeVtPane(id, frame);
      }
      now = start + t;
      out.push(await paneHold(id));
    }
    return out;
  } finally {
    closeVtPane(id);
    Date.now = realNow;
  }
}

test("the cut recording is the composer under the splash", () => {
  const text = PREFIX.map(([, chunk]) => chunk).join("");
  assert.match(text, SPLASH);
  assert.match(text, /Ask Codex to do anything/);
});

test("B-7 Codex, composer under the splash and no dialog: starting until the screen settles, then free", async () => {
  assert.deepEqual(await holdsAfterPrefix([LAST + 100, LAST + SCREEN_SETTLE_MS - 100, LAST + SCREEN_SETTLE_MS + 100]), [HOLD_STARTING, HOLD_STARTING, null]);
});

test("B-7 Codex, a splash that keeps redrawing: free at the latest SCREEN_SETTLE_MAX_MS after the spawn", async () => {
  const frame = PREFIX.findLast(([, chunk]) => SPLASH.test(chunk))[1];
  assert.deepEqual(await holdsAfterPrefix([SCREEN_SETTLE_MAX_MS - 300, SCREEN_SETTLE_MAX_MS + 100], () => frame), [HOLD_STARTING, null]);
});

test("B-7 Codex, update dialog skipped (recorded): the dialog holds, the composer after it is free", async () => {
  const [dialog, idle] = await holdsOver("codex-skip", "codex", [1_900, 7_100]);
  assert.equal(dialog, HOLD_CHOICE);
  assert.equal(idle, null);
});
