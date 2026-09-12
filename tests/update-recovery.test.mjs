// A macOS auto-update can fail in a separate ShipIt process AFTER the app
// quits, silently rolling back to the old version (#78). We can't catch it
// where it happens, only diagnose it on the next launch by comparing the
// version we asked ShipIt to install against the one we came back as. This
// pins that pure decision.

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

// ShipIt installs in a separate process after we quit. If we are already back
// up on the old version seconds later, the install is most likely still
// RUNNING - and declaring a rollback there is wrong twice: a false warning, and
// a recursive wipe of ShipIt's cache underneath a live install.
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
  // A negative age (NTP correction, dual-boot RTC, VM resume) is nonsensical,
  // not "too early". A one-sided `age < GRACE` test would answer "none" on
  // every launch until the wall clock caught up.
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

// The grace window is PER ATTEMPT, and the attempt count is what stops it
// renewing forever. Each quit re-stamps the marker, so time alone would slide
// the window indefinitely for anyone who follows the app's "Restart Aya to
// install" prompt; freezing the stamp instead would deny every retry a window
// and wipe ShipIt's cache under a live install. The count separates the two.
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

// A five-minute-old marker must be judgeable. Anchored to a literal duration,
// not to ROLLBACK_GRACE_MS, so widening the constant to hours - which would
// reinstate the never-diagnosed failure - turns this red.
test("the grace window is minutes, not hours", () => {
  assert.equal(
    diagnoseRelaunch(markerAged(5 * 60 * 1000), "0.8.0", NOW),
    "rolled-back",
  );
});

// The production call site (electron/main.ts) uses the 2-arg form and relies on
// the default clock. Every other test here passes `nowMs` explicitly, so none
// of them would notice that default becoming a monotonic clock - under which
// every real marker yields a negative age and EVERY launch reports a rollback.
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
  // Each attempt carries its OWN stamp - that is what gives it its own window.
  assert.equal(second.requestedAt, "2026-01-01T12:30:00.000Z");
});

test("a different target version restarts the count", () => {
  const prior = { targetVersion: "0.8.1", requestedAt: "x", attempts: 4 };
  assert.equal(nextAttempt("0.9.0", prior, "2026-01-01T12:00:00.000Z").attempts, 1);
});

test("the destructive cache wipe waits for a repeat failure", () => {
  // The notice is cheap and true either way; rm -rf of ShipIt's cache can land
  // underneath a live install, so it needs firmer evidence than one attempt.
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
