// A macOS auto-update can fail in a separate ShipIt process after the app quits,
// silently rolling back (#78). The only diagnosis is on the next launch: the
// version we asked ShipIt for vs the one we came back as.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseRelaunch,
  nextAttempt,
  shouldCleanShipItCache,
  ROLLBACK_GRACE_MS,
  ROLLBACK_GRACE_MAX_ATTEMPTS,
} from "../dist-electron/update-recovery.js";

/** A marker stamped `ageMs` ago, judged at a fixed "now". */
const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const markerAged = (ageMs, { targetVersion = "0.8.1", attempts = 1 } = {}) => ({
  targetVersion,
  requestedAt: new Date(NOW - ageMs).toISOString(),
  attempts,
});

test("no marker is a normal launch, not a rollback", () => {
  assert.equal(diagnoseRelaunch(null, "0.8.0"), "none");
});

test("same version means the update applied", () => {
  assert.equal(
    diagnoseRelaunch({ targetVersion: "0.8.1", requestedAt: "" }, "0.8.1"),
    "applied",
  );
});

test("still on the old version means ShipIt silently rolled back", () => {
  assert.equal(
    diagnoseRelaunch({ targetVersion: "0.8.1", requestedAt: "" }, "0.8.0"),
    "rolled-back",
  );
});

// Back on the old version seconds later usually means the install is still
// RUNNING: declaring a rollback there wipes ShipIt's cache under a live install.
test("a just-requested install is too early to call a rollback", () => {
  assert.equal(diagnoseRelaunch(markerAged(1_000), "0.8.0", NOW), "none");
  assert.equal(
    diagnoseRelaunch(markerAged(ROLLBACK_GRACE_MS - 1), "0.8.0", NOW),
    "none",
  );
});

test("past the grace window the same marker IS a rollback", () => {
  assert.equal(
    diagnoseRelaunch(markerAged(ROLLBACK_GRACE_MS), "0.8.0", NOW),
    "rolled-back",
  );
  assert.equal(
    diagnoseRelaunch(markerAged(24 * 60 * 60 * 1000), "0.8.0", NOW),
    "rolled-back",
  );
});

test("the grace window never masks a SUCCESSFUL install", () => {
  // "applied" is decided by the version, before any staleness test.
  assert.equal(diagnoseRelaunch(markerAged(1_000), "0.8.1", NOW), "applied");
});

test("a clock that moved backwards does not suppress the diagnosis forever", () => {
  // A negative age (NTP, dual-boot RTC, VM resume) is not "too early": a
  // one-sided `age < GRACE` answers "none" until the wall clock catches up.
  assert.equal(
    diagnoseRelaunch(markerAged(-6 * 60 * 60 * 1000), "0.8.0", NOW),
    "rolled-back",
  );
});

test("an unusable timestamp falls back to judging immediately", () => {
  // Markers written before requestedAt was load-bearing, or a corrupted stamp.
  assert.equal(
    diagnoseRelaunch({ targetVersion: "0.8.1", requestedAt: "" }, "0.8.0", NOW),
    "rolled-back",
  );
  assert.equal(
    diagnoseRelaunch(
      { targetVersion: "0.8.1", requestedAt: "not a date" },
      "0.8.0",
      NOW,
    ),
    "rolled-back",
  );
});

// The window is PER ATTEMPT: each quit re-stamps the marker, so time alone would
// slide it forever, while a frozen stamp would deny every retry its window.
test("a REPEAT attempt is judged immediately, however fresh its stamp", () => {
  assert.equal(
    diagnoseRelaunch(markerAged(1_000, { attempts: 2 }), "0.8.0", NOW),
    "rolled-back",
    "a second quit with the same version still pending is proof the first failed",
  );
});

test("the first attempt still gets its full window", () => {
  assert.equal(
    diagnoseRelaunch(markerAged(1_000, { attempts: 1 }), "0.8.0", NOW),
    "none",
  );
  assert.equal(ROLLBACK_GRACE_MAX_ATTEMPTS, 1);
});

test("a marker from before attempts existed counts as the first", () => {
  // Written by an older build: no `attempts` field at all.
  assert.equal(
    diagnoseRelaunch(
      {
        targetVersion: "0.8.1",
        requestedAt: new Date(NOW - 1_000).toISOString(),
      },
      "0.8.0",
      NOW,
    ),
    "none",
  );
});

// A literal 5 minutes, not ROLLBACK_GRACE_MS: widening the constant to hours
// would reinstate the never-diagnosed failure, and must turn this red.
test("the grace window is minutes, not hours", () => {
  assert.equal(
    diagnoseRelaunch(markerAged(5 * 60 * 1000), "0.8.0", NOW),
    "rolled-back",
  );
});

// main.ts uses the 2-arg form; every other test passes `nowMs`, so none would
// notice the default becoming monotonic - under which EVERY launch rolls back.
test("the default clock is the same wall clock the marker is stamped with", () => {
  const justNow = {
    targetVersion: "0.8.1",
    requestedAt: new Date(Date.now() - 1_000).toISOString(),
    attempts: 1,
  };
  assert.equal(diagnoseRelaunch(justNow, "0.8.0"), "none");
  const longAgo = {
    targetVersion: "0.8.1",
    requestedAt: new Date(Date.now() - ROLLBACK_GRACE_MS - 5_000).toISOString(),
    attempts: 1,
  };
  assert.equal(diagnoseRelaunch(longAgo, "0.8.0"), "rolled-back");
});

// --- attempt accounting ----------------------------------------------------

test("nextAttempt starts at one and increments for the same version", () => {
  const first = nextAttempt("0.8.1", null, "2026-01-01T12:00:00.000Z");
  assert.deepEqual(first, {
    targetVersion: "0.8.1",
    requestedAt: "2026-01-01T12:00:00.000Z",
    attempts: 1,
  });
  const second = nextAttempt("0.8.1", first, "2026-01-01T12:30:00.000Z");
  assert.equal(second.attempts, 2);
  // Each attempt carries its OWN stamp, which is what gives it its own window.
  assert.equal(second.requestedAt, "2026-01-01T12:30:00.000Z");
});

test("a different target version restarts the count", () => {
  const prior = { targetVersion: "0.8.1", requestedAt: "x", attempts: 4 };
  assert.equal(nextAttempt("0.9.0", prior, "2026-01-01T12:00:00.000Z").attempts, 1);
});

test("the destructive cache wipe waits for a repeat failure", () => {
  // rm -rf of ShipIt's cache can land under a live install, so it needs firmer
  // evidence than one attempt.
  assert.equal(shouldCleanShipItCache(null), false);
  assert.equal(shouldCleanShipItCache(markerAged(0, { attempts: 1 })), false);
  assert.equal(shouldCleanShipItCache(markerAged(0, { attempts: 2 })), true);
});

test("a marker with no targetVersion is treated as none, not a rollback", () => {
  assert.equal(
    diagnoseRelaunch({ targetVersion: "", requestedAt: "" }, "0.8.0"),
    "none",
  );
});
