import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pollVisible,
  SESSION_MONITOR_POLL_INTERVAL_MS,
  USAGE_POLL_INTERVAL_MS,
} from "../dist-test/poll-visible.js";

function pollingEnvironment(t, hidden = false) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const document = new EventTarget();
  document.hidden = hidden;
  const window = {
    setInterval: t.mock.fn((...args) => globalThis.setInterval(...args)),
    clearInterval: t.mock.fn((id) => globalThis.clearInterval(id)),
  };
  const previousGlobals = new Map();
  const stops = [];
  for (const [name, value] of Object.entries({ window, document })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  t.after(() => {
    for (const stop of stops) stop();
    for (const [name, previous] of previousGlobals) {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    }
  });
  const poll = (refresh, interval) => {
    const stop = pollVisible(refresh, interval);
    stops.push(stop);
    return stop;
  };
  const setHidden = (value) => {
    document.hidden = value;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { window, document, setHidden, poll };
}

test("refresh runs before the timer and visibility listener are registered", (t) => {
  const { window, document, poll } = pollingEnvironment(t);
  const addListener = t.mock.method(document, "addEventListener");
  let calls = 0;
  const stop = poll(() => {
    if (calls === 0) {
      assert.equal(window.setInterval.mock.callCount(), 0);
      assert.equal(addListener.mock.callCount(), 0);
    }
    calls += 1;
  }, 1000);
  assert.equal(calls, 1);
  assert.equal(window.setInterval.mock.callCount(), 1);
  assert.equal(addListener.mock.callCount(), 1);
  assert.equal(addListener.mock.calls[0].arguments[0], "visibilitychange");
});

for (const [name, interval, expectedMs] of [
  ["usage", USAGE_POLL_INTERVAL_MS, 30_000],
  ["sessions", SESSION_MONITOR_POLL_INTERVAL_MS, 5_000],
]) {
  test(`${name} refreshes at its existing polling cadence`, (t) => {
    const { poll } = pollingEnvironment(t);
    let calls = 0;
    poll(() => { calls += 1; }, interval);
    assert.equal(calls, 1);
    t.mock.timers.tick(expectedMs - 1);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    assert.equal(calls, 2);
    t.mock.timers.tick(expectedMs);
    assert.equal(calls, 3);
  });
}

test("hidden ticks and hidden visibility events skip refresh", (t) => {
  const { setHidden, poll } = pollingEnvironment(t);
  let calls = 0;
  poll(() => { calls += 1; }, 1000);
  setHidden(true);
  t.mock.timers.tick(3000);
  setHidden(true);
  assert.equal(calls, 1);
  setHidden(false);
  assert.equal(calls, 2);
  t.mock.timers.tick(1000);
  assert.equal(calls, 3);
});

test("an initially hidden document still gets the initial refresh", (t) => {
  const { setHidden, poll } = pollingEnvironment(t, true);
  let calls = 0;
  poll(() => { calls += 1; }, 1000);
  assert.equal(calls, 1);
  t.mock.timers.tick(2000);
  assert.equal(calls, 1);
  setHidden(false);
  assert.equal(calls, 2);
});

test("becoming visible refreshes immediately without resetting the interval", (t) => {
  const { setHidden, poll } = pollingEnvironment(t);
  let calls = 0;
  poll(() => { calls += 1; }, 1000);
  setHidden(true);
  t.mock.timers.tick(2500);
  setHidden(false);
  assert.equal(calls, 2);
  t.mock.timers.tick(499);
  assert.equal(calls, 2);
  t.mock.timers.tick(1);
  assert.equal(calls, 3);
  setHidden(true);
  setHidden(false);
  assert.equal(calls, 4);
});

test("cleanup clears its timer and removes its visibility listener", (t) => {
  const { window, document, setHidden, poll } = pollingEnvironment(t);
  const addListener = t.mock.method(document, "addEventListener");
  const removeListener = t.mock.method(document, "removeEventListener");
  let calls = 0;
  const stop = poll(() => { calls += 1; }, 1000);
  stop();
  assert.equal(window.clearInterval.mock.callCount(), 1);
  assert.equal(
    window.clearInterval.mock.calls[0].arguments[0],
    window.setInterval.mock.calls[0].result,
  );
  assert.equal(removeListener.mock.callCount(), 1);
  assert.deepEqual(
    removeListener.mock.calls[0].arguments,
    addListener.mock.calls[0].arguments,
  );
  t.mock.timers.tick(3000);
  setHidden(true);
  setHidden(false);
  assert.equal(calls, 1);
});

test("stopping one poll leaves another poll and its listener active", (t) => {
  const { setHidden, poll } = pollingEnvironment(t);
  let usageCalls = 0;
  let sessionCalls = 0;
  const stopUsage = poll(() => { usageCalls += 1; }, USAGE_POLL_INTERVAL_MS);
  poll(() => { sessionCalls += 1; }, SESSION_MONITOR_POLL_INTERVAL_MS);
  stopUsage();
  t.mock.timers.tick(30_000);
  assert.equal(usageCalls, 1);
  assert.equal(sessionCalls, 7);
  setHidden(true);
  setHidden(false);
  assert.equal(usageCalls, 1);
  assert.equal(sessionCalls, 8);
});
