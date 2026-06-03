// Usage snapshot validation — Aya only ever READS this file (a user hook
// writes it), so the validator is the guard against a stale/hand-broken file
// crashing or mis-rendering the chip. parseUsage must return null on anything
// that isn't the exact shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsageData, parseUsage } from "../dist-electron/usage.js";

const valid = {
  fiveHour: { pct: 30, resetsAt: "2026-06-03T17:20:00Z" },
  sevenDay: { pct: 55, resetsAt: "2026-06-06T15:00:00Z" },
  updatedAt: "2026-06-03T14:32:00Z",
};

test("accepts a full, well-formed snapshot", () => {
  assert.equal(isUsageData(valid), true);
});

test("accepts windows without resetsAt (optional)", () => {
  assert.equal(
    isUsageData({
      fiveHour: { pct: 0 },
      sevenDay: { pct: 100 },
      updatedAt: "2026-06-03T14:32:00Z",
    }),
    true,
  );
});

test("rejects a missing window", () => {
  assert.equal(isUsageData({ fiveHour: { pct: 30 }, updatedAt: "x" }), false);
});

test("rejects a non-numeric pct", () => {
  assert.equal(
    isUsageData({ ...valid, sevenDay: { pct: "55" } }),
    false,
  );
});

test("rejects a negative pct", () => {
  assert.equal(isUsageData({ ...valid, fiveHour: { pct: -1 } }), false);
});

test("rejects a non-finite pct (NaN/Infinity)", () => {
  assert.equal(isUsageData({ ...valid, fiveHour: { pct: NaN } }), false);
  assert.equal(isUsageData({ ...valid, sevenDay: { pct: Infinity } }), false);
});

test("rejects a missing updatedAt", () => {
  assert.equal(
    isUsageData({ fiveHour: { pct: 30 }, sevenDay: { pct: 55 } }),
    false,
  );
});

test("rejects null and non-objects", () => {
  assert.equal(isUsageData(null), false);
  assert.equal(isUsageData(42), false);
  assert.equal(isUsageData("usage"), false);
});

test("parseUsage returns null on malformed JSON", () => {
  assert.equal(parseUsage("{ not json"), null);
});

test("parseUsage returns null on valid JSON of the wrong shape", () => {
  assert.equal(parseUsage(JSON.stringify({ foo: 1 })), null);
});

test("parseUsage returns the parsed object for a valid snapshot", () => {
  const out = parseUsage(JSON.stringify(valid));
  assert.deepEqual(out, valid);
});
