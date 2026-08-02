// Codecs behind usePersistentPreference. These back 7 shipped preferences
// (theme, mac-option, harness-name, github-link, layout, summaries, and the
// worktrees flag), so their read-with-fallback / write semantics matter: a
// wrong default or a dropped explicit value silently changes a setting. Only
// the codecs are pure; the hook itself needs React and isn't tested here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boolPreference,
  enumPreference,
} from "../dist-test/hooks/usePersistentPreference.js";

test("boolPreference(false): default off, only \"1\" is true", () => {
  const c = boolPreference(false);
  assert.equal(c.fallback, false); // missing key -> off (github-link/summaries/worktrees)
  assert.equal(c.parse("1"), true);
  assert.equal(c.parse("0"), false);
  assert.equal(c.parse("anything-else"), false);
  assert.equal(c.serialize(true), "1");
  assert.equal(c.serialize(false), "0");
});

test("boolPreference(true): default on, only \"0\" is false", () => {
  const c = boolPreference(true);
  assert.equal(c.fallback, true); // missing key -> on (harness names)
  assert.equal(c.parse("0"), false);
  assert.equal(c.parse("1"), true);
  assert.equal(c.parse("garbage"), true); // anything but "0" reads as on
  assert.equal(c.serialize(true), "1");
  assert.equal(c.serialize(false), "0");
});

test("boolPreference round-trips both values through serialize->parse", () => {
  for (const def of [true, false]) {
    const c = boolPreference(def);
    assert.equal(c.parse(c.serialize(true)), true);
    assert.equal(c.parse(c.serialize(false)), false);
  }
});

test("enumPreference: known values pass through, unknown falls back", () => {
  const c = enumPreference(["classic", "projects-left"], "classic");
  assert.equal(c.fallback, "classic");
  assert.equal(c.parse("projects-left"), "projects-left");
  assert.equal(c.parse("classic"), "classic");
  assert.equal(c.parse("bogus"), "classic"); // invalid stored value -> default
  assert.equal(c.parse(""), "classic");
  assert.equal(c.serialize("projects-left"), "projects-left");
});
