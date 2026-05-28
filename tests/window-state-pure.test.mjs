// Pure helpers extracted from window-state. The display-disconnect fallback
// is the bit that matters most: if a saved position pointed at a monitor that
// is no longer connected, Aya must not open off-screen. These tests pin that
// contract and the input validation around it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WINDOW_STATE,
  VISIBLE_OVERLAP_MIN,
  isWindowState,
  isVisibleOnAnyDisplay,
  resolveLoadedWindowState,
} from "../dist-electron/window-state-pure.js";

const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1200 } };
const SECONDARY_RIGHT = { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } };

const VALID_STATE = {
  x: 100,
  y: 100,
  width: 1280,
  height: 800,
  isFullScreen: false,
  isMaximized: false,
};

// --- isWindowState -------------------------------------------------------

test("isWindowState accepts a fully-populated state", () => {
  assert.equal(isWindowState(VALID_STATE), true);
});

test("isWindowState rejects null and non-objects", () => {
  assert.equal(isWindowState(null), false);
  assert.equal(isWindowState(undefined), false);
  assert.equal(isWindowState("not-an-object"), false);
  assert.equal(isWindowState(42), false);
  assert.equal(isWindowState([1, 2, 3]), false);
});

test("isWindowState rejects missing numeric fields", () => {
  const { x: _x, ...withoutX } = VALID_STATE;
  void _x;
  assert.equal(isWindowState(withoutX), false);
});

test("isWindowState rejects wrong-typed fields (e.g. string width)", () => {
  assert.equal(isWindowState({ ...VALID_STATE, width: "1280" }), false);
  assert.equal(
    isWindowState({ ...VALID_STATE, isFullScreen: "true" }),
    false,
  );
});

// --- isVisibleOnAnyDisplay ----------------------------------------------

test("isVisibleOnAnyDisplay: window fully inside the primary display", () => {
  const rect = { x: 200, y: 200, width: 800, height: 600 };
  assert.equal(isVisibleOnAnyDisplay(rect, [PRIMARY]), true);
});

test("isVisibleOnAnyDisplay: window overlaps a secondary display only", () => {
  const rect = { x: 2400, y: 200, width: 800, height: 600 };
  assert.equal(
    isVisibleOnAnyDisplay(rect, [PRIMARY, SECONDARY_RIGHT]),
    true,
  );
});

test("isVisibleOnAnyDisplay: window entirely off-screen returns false", () => {
  const rect = { x: -10_000, y: -10_000, width: 1280, height: 800 };
  assert.equal(isVisibleOnAnyDisplay(rect, [PRIMARY]), false);
});

test("isVisibleOnAnyDisplay: overlap smaller than the threshold returns false", () => {
  // A 50x50 overlap is below VISIBLE_OVERLAP_MIN (100), so this counts as
  // "not really visible".
  const just = VISIBLE_OVERLAP_MIN - 1;
  const rect = { x: -1280 + just, y: -800 + just, width: 1280, height: 800 };
  assert.equal(isVisibleOnAnyDisplay(rect, [PRIMARY]), false);
});

test("isVisibleOnAnyDisplay: exactly VISIBLE_OVERLAP_MIN overlap counts as visible", () => {
  const rect = {
    x: -1280 + VISIBLE_OVERLAP_MIN,
    y: -800 + VISIBLE_OVERLAP_MIN,
    width: 1280,
    height: 800,
  };
  assert.equal(isVisibleOnAnyDisplay(rect, [PRIMARY]), true);
});

test("isVisibleOnAnyDisplay: empty display list returns false (no monitors)", () => {
  assert.equal(isVisibleOnAnyDisplay(VALID_STATE, []), false);
});

// --- resolveLoadedWindowState -------------------------------------------

test("resolveLoadedWindowState: visible saved state passes through unchanged", () => {
  const out = resolveLoadedWindowState(VALID_STATE, [PRIMARY]);
  assert.deepEqual(out, VALID_STATE);
});

test("resolveLoadedWindowState: disconnected-monitor state keeps size, resets position", () => {
  const saved = { ...VALID_STATE, x: 5000, y: 5000, width: 1500, height: 950 };
  const out = resolveLoadedWindowState(saved, [PRIMARY]);
  assert.equal(out.x, DEFAULT_WINDOW_STATE.x);
  assert.equal(out.y, DEFAULT_WINDOW_STATE.y);
  // Remembered size carries over so the user keeps their preferred dimensions.
  assert.equal(out.width, 1500);
  assert.equal(out.height, 950);
  // Maximized / fullscreen flags drop to defaults (they were tied to the
  // disconnected display's geometry).
  assert.equal(out.isFullScreen, DEFAULT_WINDOW_STATE.isFullScreen);
  assert.equal(out.isMaximized, DEFAULT_WINDOW_STATE.isMaximized);
});

test("resolveLoadedWindowState: malformed input returns the defaults", () => {
  assert.deepEqual(
    resolveLoadedWindowState({ bogus: true }, [PRIMARY]),
    DEFAULT_WINDOW_STATE,
  );
  assert.deepEqual(
    resolveLoadedWindowState(null, [PRIMARY]),
    DEFAULT_WINDOW_STATE,
  );
  assert.deepEqual(
    resolveLoadedWindowState("not a state", [PRIMARY]),
    DEFAULT_WINDOW_STATE,
  );
});

test("resolveLoadedWindowState: no displays connected returns defaults (size kept)", () => {
  const out = resolveLoadedWindowState(VALID_STATE, []);
  assert.equal(out.x, DEFAULT_WINDOW_STATE.x);
  assert.equal(out.y, DEFAULT_WINDOW_STATE.y);
  assert.equal(out.width, VALID_STATE.width);
  assert.equal(out.height, VALID_STATE.height);
});
