// PTY event bus: one underlying subscription, per-ptyId fan-out. The routing
// contract matters: a chunk for terminal X must invoke X's handlers and the
// App-level "any" router — and nothing else (that "nothing else" is the perf
// win over the old per-TerminalView broadcast).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPtyEventBus } from "../dist-test/ptyEventBus.js";

function makeSource() {
  const emitters = [];
  return {
    subscribe(handler) {
      emitters.push(handler);
      return () => {
        const i = emitters.indexOf(handler);
        if (i >= 0) emitters.splice(i, 1);
      };
    },
    emit(event) {
      for (const h of [...emitters]) h(event);
    },
    count() {
      return emitters.length;
    },
  };
}

const data = (ptyId, chunk = "x") => ({ type: "data", ptyId, chunk });

test("routes an event to its ptyId handlers and the any-router only", () => {
  const src = makeSource();
  const bus = createPtyEventBus(src.subscribe);
  const calls = { a: 0, b: 0, any: 0 };
  bus.onFor("a", () => (calls.a += 1));
  bus.onFor("b", () => (calls.b += 1));
  bus.onAny(() => (calls.any += 1));

  src.emit(data("a"));
  assert.deepEqual(calls, { a: 1, b: 0, any: 1 });
  src.emit(data("b"));
  src.emit(data("b"));
  assert.deepEqual(calls, { a: 1, b: 2, any: 3 });
  // Unknown id: only the any-router sees it.
  src.emit(data("ghost"));
  assert.deepEqual(calls, { a: 1, b: 2, any: 4 });
});

test("exactly ONE underlying subscription regardless of handler count", () => {
  const src = makeSource();
  const bus = createPtyEventBus(src.subscribe);
  for (let i = 0; i < 20; i++) bus.onFor(`pty-${i}`, () => {});
  bus.onAny(() => {});
  assert.equal(src.count(), 1);
});

test("unsubscribe stops delivery; other handlers unaffected", () => {
  const src = makeSource();
  const bus = createPtyEventBus(src.subscribe);
  const calls = { first: 0, second: 0, any: 0 };
  const offFirst = bus.onFor("a", () => (calls.first += 1));
  bus.onFor("a", () => (calls.second += 1));
  const offAny = bus.onAny(() => (calls.any += 1));

  src.emit(data("a"));
  offFirst();
  src.emit(data("a"));
  assert.deepEqual(calls, { first: 1, second: 2, any: 2 });
  offAny();
  src.emit(data("a"));
  assert.deepEqual(calls, { first: 1, second: 3, any: 2 });
});

test("remount pattern: unsubscribe + resubscribe same id keeps routing", () => {
  const src = makeSource();
  const bus = createPtyEventBus(src.subscribe);
  let calls = 0;
  const off = bus.onFor("a", () => (calls += 1));
  src.emit(data("a"));
  off(); // TerminalView unmounts (project switch)…
  src.emit(data("a"));
  bus.onFor("a", () => (calls += 1)); // …and remounts.
  src.emit(data("a"));
  assert.equal(calls, 2);
});

test("events pass through verbatim (same object reference)", () => {
  const src = makeSource();
  const bus = createPtyEventBus(src.subscribe);
  const seen = [];
  bus.onFor("a", (e) => seen.push(e));
  const event = data("a", "chunk-payload");
  src.emit(event);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], event);
});
