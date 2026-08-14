// Server-side screen mirror. The whole point of this module is that it knows
// what a pane SHOWS, not merely what bytes went past — so the tests that
// matter are the ones a raw-byte regex (src/bell.ts) would get wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __testScanVtPane,
  __testVtPane,
  closeAllVtPanes,
  closeVtPane,
  openVtPane,
  resizeVtPane,
  screenShowsApproval,
  screenTail,
  writeVtPane,
} from "../dist-electron/vt-state.js";

// xterm parses writes asynchronously, so a scan must come after a tick.
const settle = () => new Promise((r) => setTimeout(r, 20));

function open(id, onChange = () => {}) {
  openVtPane(id, 80, 24, onChange);
  return () => closeVtPane(id);
}

test("an approval prompt on screen is detected", async () => {
  const close = open("p1");
  writeVtPane("p1", "Do you want to proceed?\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p1").terminal), true);
  close();
});

test("a prompt that was REPAINTED AWAY is not detected", async () => {
  // The regression this module exists for: the bytes still contain the
  // prompt, but the agent has cleared the screen since. A byte-stream matcher
  // would keep the terminal stuck as "waiting" forever.
  const close = open("p2");
  writeVtPane("p2", "Do you want to proceed?\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p2").terminal), true);

  writeVtPane("p2", "\x1b[H\x1b[2JAll done, nothing pending.\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p2").terminal), false);
  close();
});

test("a prompt scrolled off the visible screen is not detected", async () => {
  const close = open("p3");
  writeVtPane("p3", "Do you want to proceed?\r\n");
  writeVtPane("p3", "filler\r\n".repeat(60));
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p3").terminal), false);
  close();
});

test("ordinary output is not mistaken for a prompt", async () => {
  const close = open("p4");
  writeVtPane("p4", "Compiling module foo\r\nDone in 2.1s\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p4").terminal), false);
  close();
});

test("a bare [y/n] at the end of a line counts as a prompt", async () => {
  const close = open("p5");
  writeVtPane("p5", "Overwrite existing file? [y/n]");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p5").terminal), true);
  close();
});

// --- screenTail ------------------------------------------------------------

test("screenTail returns rendered lines oldest-first, blank rows skipped", async () => {
  const close = open("p6");
  writeVtPane("p6", "one\r\n\r\ntwo\r\nthree\r\n");
  await settle();
  const tail = screenTail(__testVtPane("p6").terminal);
  assert.equal(tail, "one\ntwo\nthree");
  close();
});

test("screenTail is bounded by its line limit", async () => {
  const close = open("p7");
  writeVtPane("p7", "line\r\n".repeat(20));
  await settle();
  const tail = screenTail(__testVtPane("p7").terminal, 3);
  assert.equal(tail.split("\n").length, 3);
  close();
});

// --- change notification ---------------------------------------------------

test("the change callback fires on BOTH edges, once per transition", async () => {
  const seen = [];
  const close = open("p8", (waiting) => seen.push(waiting));

  writeVtPane("p8", "Do you want to proceed?\r\n");
  await settle();
  __testScanVtPane("p8");
  assert.deepEqual(seen, [true]);

  // A second scan with the screen unchanged must not re-fire.
  __testScanVtPane("p8");
  assert.deepEqual(seen, [true]);

  writeVtPane("p8", "\x1b[H\x1b[2Jmoving on\r\n");
  await settle();
  __testScanVtPane("p8");
  assert.deepEqual(seen, [true, false]);
  close();
});

// --- lifecycle -------------------------------------------------------------

test("writing to an unknown pane is a silent no-op, not a throw", () => {
  assert.doesNotThrow(() => writeVtPane("ghost", "hi"));
  assert.doesNotThrow(() => resizeVtPane("ghost", 10, 10));
  assert.doesNotThrow(() => closeVtPane("ghost"));
});

test("closing a pane drops it, so a respawned id starts clean", async () => {
  const close = open("p9");
  writeVtPane("p9", "Do you want to proceed?\r\n");
  await settle();
  close();
  assert.equal(__testVtPane("p9"), undefined);

  open("p9")();
  assert.equal(__testVtPane("p9"), undefined);
});

test("resize keeps the pane usable", async () => {
  const close = open("p10");
  resizeVtPane("p10", 40, 10);
  writeVtPane("p10", "Do you want to proceed?\r\n");
  await settle();
  assert.equal(screenShowsApproval(__testVtPane("p10").terminal), true);
  close();
});

test("closeAllVtPanes clears everything (host shutdown)", async () => {
  open("p11");
  open("p12");
  closeAllVtPanes();
  assert.equal(__testVtPane("p11"), undefined);
  assert.equal(__testVtPane("p12"), undefined);
});
