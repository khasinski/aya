// Shift-Shift global search detector. UX-critical (it's the primary way users
// open search) and easy to break by accident if anyone tweaks the modifier
// rules or the timing window. These tests pin the contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOUBLE_SHIFT_WINDOW_MS,
  handleKeyDown,
  handleKeyUp,
  initialDoubleShiftState,
} from "../dist-test/double-shift.js";

// Convenience: drive the state machine through a sequence of events.
function shiftUp(state, now, modifiers = {}) {
  return handleKeyUp(state, { key: "Shift", ...modifiers }, now);
}

test("two Shift taps within the window trigger", () => {
  let s = initialDoubleShiftState;
  const r1 = shiftUp(s, 1000);
  s = r1.state;
  assert.equal(r1.triggered, false);
  const r2 = shiftUp(s, 1200);
  assert.equal(r2.triggered, true);
});

test("two Shift taps exactly at the window boundary do not trigger", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 0).state;
  // strictly less than the window — 300ms exactly should NOT trigger.
  const r = shiftUp(s, DOUBLE_SHIFT_WINDOW_MS);
  assert.equal(r.triggered, false);
});

test("two Shift taps just under the window boundary do trigger", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 0).state;
  const r = shiftUp(s, DOUBLE_SHIFT_WINDOW_MS - 1);
  assert.equal(r.triggered, true);
});

test("two Shift taps far apart do not trigger", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 1000).state;
  const r = shiftUp(s, 2000);
  assert.equal(r.triggered, false);
  // The late second tap restarts the chain so a quick follow-up could trigger.
  assert.equal(r.state.chainActive, true);
});

test("three quick Shifts only trigger on the second; third starts a new chain", () => {
  let s = initialDoubleShiftState;
  const r1 = shiftUp(s, 100);
  s = r1.state;
  const r2 = shiftUp(s, 200);
  s = r2.state;
  const r3 = shiftUp(s, 300);
  assert.equal(r1.triggered, false);
  assert.equal(r2.triggered, true);
  assert.equal(r3.triggered, false);
  assert.equal(r3.state.chainActive, true);
});

test("pressing a non-Shift key during the chain cancels it", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  s = handleKeyDown(s, { key: "a" });
  assert.equal(s.chainActive, false);
  const r = shiftUp(s, 200);
  assert.equal(r.triggered, false);
});

test("Shift keydown does not cancel the chain", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  s = handleKeyDown(s, { key: "Shift" });
  assert.equal(s.chainActive, true);
});

test("Cmd-Shift up is ignored (real chord, not double-shift)", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  const r = shiftUp(s, 200, { metaKey: true });
  assert.equal(r.triggered, false);
});

test("Ctrl-Shift up is ignored", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  const r = shiftUp(s, 200, { ctrlKey: true });
  assert.equal(r.triggered, false);
});

test("Alt-Shift up is ignored", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  const r = shiftUp(s, 200, { altKey: true });
  assert.equal(r.triggered, false);
});

test("non-Shift keyup does not affect the chain", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  const beforeChain = s.chainActive;
  const r = handleKeyUp(s, { key: "a" }, 150);
  assert.equal(r.triggered, false);
  assert.equal(r.state.chainActive, beforeChain);
});

test("after a successful trigger, a third Shift starts a fresh chain", () => {
  let s = initialDoubleShiftState;
  s = shiftUp(s, 100).state;
  const triggered = shiftUp(s, 200);
  assert.equal(triggered.triggered, true);
  s = triggered.state;
  // chain should be reset, so the next tap must not immediately re-trigger.
  const next = shiftUp(s, 250);
  assert.equal(next.triggered, false);
  assert.equal(next.state.chainActive, true);
});
