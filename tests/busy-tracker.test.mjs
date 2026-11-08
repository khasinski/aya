import test from "node:test";
import assert from "node:assert/strict";
import { BusyTracker, BUSY_RELEASE_MS, BUSY_REPEAT_MS } from "../dist-electron/busy-tracker.js";

function fixture() {
  let now = 0, next = 1;
  const timers = new Map();
  const events = [];
  const tracker = new BusyTracker((id, busy) => events.push([id, busy]), {
    setTimeout: (fn, ms) => { const h = next++; timers.set(h, { fn, at: now + ms }); return h; },
    clearTimeout: (h) => timers.delete(h),
    now: () => now,
  });
  const advance = (ms) => {
    now += ms;
    for (const [h, t] of [...timers]) if (t.at <= now) { timers.delete(h); t.fn(); }
  };
  return { tracker, events, advance };
}

test("busy is reported at once and repeated only after the repeat interval", () => {
  const { tracker, events, advance } = fixture();
  tracker.observe("a", true);
  tracker.observe("a", true);
  assert.deepEqual(events, [["a", true]]);
  advance(BUSY_REPEAT_MS);
  tracker.observe("a", true);
  assert.deepEqual(events, [["a", true], ["a", true]]);
});

test("a repaint between tool calls does not release busy", () => {
  const { tracker, events, advance } = fixture();
  tracker.observe("a", true);
  tracker.observe("a", false);
  advance(BUSY_RELEASE_MS - 1);
  tracker.observe("a", true);
  advance(BUSY_RELEASE_MS * 2);
  assert.deepEqual(events, [["a", true]]);
});

test("a screen that stays not busy releases once, after the delay", () => {
  const { tracker, events, advance } = fixture();
  tracker.observe("a", true);
  tracker.observe("a", false);
  tracker.observe("a", false);
  advance(BUSY_RELEASE_MS);
  assert.deepEqual(events, [["a", true], ["a", false]]);
  tracker.observe("a", false);
  advance(BUSY_RELEASE_MS);
  assert.equal(events.length, 2);
});

test("an unreadable screen has no opinion, and a gone pane releases at once", () => {
  const { tracker, events, advance } = fixture();
  tracker.observe("a", null);
  assert.deepEqual(events, []);
  tracker.observe("a", true);
  tracker.observe("a", null);
  advance(BUSY_RELEASE_MS * 2);
  assert.deepEqual(events, [["a", true]]);
  tracker.release("a");
  assert.deepEqual(events, [["a", true], ["a", false]]);
  tracker.release("a");
  assert.equal(events.length, 2);
});

test("panes are tracked separately", () => {
  const { tracker, events, advance } = fixture();
  tracker.observe("a", true);
  tracker.observe("b", true);
  tracker.observe("a", false);
  advance(BUSY_RELEASE_MS);
  assert.deepEqual(events, [["a", true], ["b", true], ["a", false]]);
});
