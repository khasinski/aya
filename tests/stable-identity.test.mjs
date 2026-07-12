// Content comparators behind useStable. These decide whether Sidebar/TopBar
// see a new prop identity on a terminals-map change, so a false "same" would
// freeze the UI on real changes and a false "different" re-renders for
// nothing — both directions matter.

import { test } from "node:test";
import assert from "node:assert/strict";

const { sameArrayItems, sameRecordValues } = await import(
  "../dist-test/stable-identity.js"
);

test("sameArrayItems: reference equality per element", () => {
  const x = { id: 1 };
  const y = { id: 2 };
  assert.ok(sameArrayItems([x, y], [x, y]));
  assert.ok(!sameArrayItems([x, y], [y, x])); // order matters
  assert.ok(!sameArrayItems([x], [x, y]));
  assert.ok(!sameArrayItems([x], [{ id: 1 }])); // equal shape, new ref
  assert.ok(sameArrayItems([], []));
});

test("sameRecordValues: key set + per-key values, order-insensitive", () => {
  const x = { n: 1 };
  assert.ok(sameRecordValues({ a: x, b: x }, { b: x, a: x }));
  assert.ok(!sameRecordValues({ a: x }, { a: x, b: x }));
  assert.ok(!sameRecordValues({ a: x }, { b: x }));
  assert.ok(!sameRecordValues({ a: x }, { a: { n: 1 } })); // default Object.is
});

test("sameRecordValues honors a custom value comparator", () => {
  const byCountLevel = (p, q) => p.count === q.count && p.level === q.level;
  assert.ok(
    sameRecordValues(
      { aya: { count: 2, level: "waiting" } },
      { aya: { count: 2, level: "waiting" } },
      byCountLevel,
    ),
  );
  assert.ok(
    !sameRecordValues(
      { aya: { count: 2, level: "waiting" } },
      { aya: { count: 2, level: "error" } },
      byCountLevel,
    ),
  );
});
