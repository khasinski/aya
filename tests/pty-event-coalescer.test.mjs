// PTY data coalescing. Ordering is the load-bearing property: within one
// (ptyId, replay) stream, chunks must concatenate in arrival order, and a
// non-data event (exit/spawn-failed/no-session) must never overtake the data
// that preceded it. Cross-pty interleaving carries no meaning and MAY reorder.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createPtyDataCoalescer, coalesceAdjacentData } = await import(
  "../dist-electron/pty-event-coalescer.js"
);

const data = (ptyId, chunk, replay = undefined) =>
  replay === undefined
    ? { type: "data", ptyId, chunk }
    : { type: "data", ptyId, chunk, replay };

function manualScheduler() {
  const queue = [];
  return {
    schedule: (flush) => queue.push(flush),
    run: () => {
      while (queue.length) queue.shift()();
    },
  };
}

test("chunks of one stream merge into a single event per flush", () => {
  const sent = [];
  const s = manualScheduler();
  const c = createPtyDataCoalescer((e) => sent.push(e), s.schedule);
  c.push(data("a", "one "));
  c.push(data("b", "B1"));
  c.push(data("a", "two "));
  c.push(data("a", "three"));
  assert.equal(sent.length, 0); // nothing until the scheduled flush
  s.run();
  assert.deepEqual(sent, [data("a", "one two three"), data("b", "B1")]);
});

test("replay and live chunks of the same pty stay separate events", () => {
  const sent = [];
  const s = manualScheduler();
  const c = createPtyDataCoalescer((e) => sent.push(e), s.schedule);
  c.push(data("a", "R1", true));
  c.push(data("a", "L1"));
  c.push(data("a", "R2", true));
  s.run();
  assert.deepEqual(sent, [data("a", "R1R2", true), data("a", "L1")]);
});

test("a non-data event flushes pending data first (exit can't overtake output)", () => {
  const sent = [];
  const s = manualScheduler();
  const c = createPtyDataCoalescer((e) => sent.push(e), s.schedule);
  c.push(data("a", "last words"));
  c.push({ type: "exit", ptyId: "a", exitCode: 0 });
  assert.deepEqual(sent, [
    data("a", "last words"),
    { type: "exit", ptyId: "a", exitCode: 0 },
  ]);
  s.run(); // the already-scheduled flush finds nothing left
  assert.equal(sent.length, 2);
});

test("a stream exceeding the size cap flushes early", () => {
  const sent = [];
  const s = manualScheduler();
  const c = createPtyDataCoalescer((e) => sent.push(e), s.schedule, 10);
  c.push(data("a", "123456"));
  c.push(data("a", "789012")); // 12 chars >= cap of 10
  assert.deepEqual(sent, [data("a", "123456789012")]);
});

test("pushed event objects are not mutated by merging", () => {
  const s = manualScheduler();
  const c = createPtyDataCoalescer(() => {}, s.schedule);
  const first = data("a", "one");
  c.push(first);
  c.push(data("a", "two"));
  s.run();
  assert.equal(first.chunk, "one");
});

test("flush is idempotent and a later chunk schedules a new flush", () => {
  const sent = [];
  const s = manualScheduler();
  const c = createPtyDataCoalescer((e) => sent.push(e), s.schedule);
  c.push(data("a", "1"));
  s.run();
  s.run();
  c.push(data("a", "2"));
  s.run();
  assert.deepEqual(sent, [data("a", "1"), data("a", "2")]);
});

test("coalesceAdjacentData merges only same-stream neighbors", () => {
  const events = [
    data("a", "1"),
    data("a", "2"),
    data("b", "B"),
    data("a", "3"),
    { type: "exit", ptyId: "a", exitCode: 0 },
    data("a", "late"),
    data("a", "r1", true),
    data("a", "r2", true),
  ];
  const snapshot = JSON.parse(JSON.stringify(events));
  assert.deepEqual(coalesceAdjacentData(events), [
    data("a", "12"),
    data("b", "B"),
    data("a", "3"),
    { type: "exit", ptyId: "a", exitCode: 0 },
    data("a", "late"),
    data("a", "r1r2", true),
  ]);
  // Input events must come out untouched (the merged head is a clone).
  assert.deepEqual(events, snapshot);
});

test("coalesceAdjacentData passes through short batches", () => {
  const one = [data("a", "x")];
  assert.equal(coalesceAdjacentData(one), one);
  assert.deepEqual(coalesceAdjacentData([]), []);
});
