import { test } from "node:test";
import assert from "node:assert/strict";
import { boolPreference, enumPreference } from "../dist-test/preference-codecs.js";

test("boolean factories keep separate defaults and round-trip flags", () => {
  const on = boolPreference(true);
  const off = boolPreference(false);
  assert.equal(on.fallback, true);
  assert.equal(off.fallback, false);
  for (const value of [true, false]) {
    for (const codec of [on, off]) {
      assert.equal(codec.serialize(value), value ? "1" : "0");
      assert.equal(codec.parse(codec.serialize(value)), value);
    }
  }
  assert.equal(on.parse("unknown"), true);
  assert.equal(off.parse("unknown"), false);
});

test("enum factory uses exact membership and the caller's fallback", () => {
  const codec = enumPreference(["a", "b"], "b");
  assert.equal(codec.fallback, "b");
  assert.equal(codec.parse("a"), "a");
  assert.equal(codec.parse("b"), "b");
  for (const raw of ["", "A", " a", "c"]) assert.equal(codec.parse(raw), "b");
  assert.equal(codec.serialize("a"), "a");
});

test("enum factory snapshots allowed values when the codec is created", () => {
  const values = ["a"];
  const codec = enumPreference(values, "default");
  values.push("b");
  assert.equal(codec.parse("a"), "a");
  assert.equal(codec.parse("b"), "default");
});
