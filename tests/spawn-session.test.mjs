// Confirmed-session registry behind attach-only re-mounts. Keying on confirmed
// output (not the spawn request) is what avoids two bugs: a false "no-session"
// when an in-flight first spawn re-mounts, and a stuck-stopped tab when an
// explicit restart targets an unmounted terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markSpawned,
  wasSpawned,
  forgetSpawn,
  markNoSession,
  hadNoSession,
  markMountDecided,
  wasMountDecided,
} from "../dist-test/spawnSession.js";

test("an unseen id was not spawned (first mount spawns normally)", () => {
  assert.equal(wasSpawned("ss-new"), false);
});

test("markSpawned records a confirmed session (re-mount attaches)", () => {
  assert.equal(wasSpawned("ss-a"), false);
  markSpawned("ss-a");
  assert.equal(wasSpawned("ss-a"), true);
});

test("forgetSpawn clears the marker so the next mount spawns fresh", () => {
  markSpawned("ss-b");
  assert.equal(wasSpawned("ss-b"), true);
  forgetSpawn("ss-b");
  assert.equal(wasSpawned("ss-b"), false);
});

test("forgetSpawn on an unknown id is a harmless no-op", () => {
  forgetSpawn("ss-never");
  assert.equal(wasSpawned("ss-never"), false);
});

test("a no-session verdict sticks: the re-mount must attach and stay stopped", () => {
  assert.equal(hadNoSession("ss-ns"), false);
  markNoSession("ss-ns");
  assert.equal(hadNoSession("ss-ns"), true);
});

test("the first mount decision is one-shot (gates boot-time attachIfReused)", () => {
  assert.equal(wasMountDecided("ss-md"), false);
  markMountDecided("ss-md");
  assert.equal(wasMountDecided("ss-md"), true);
});

test("forgetSpawn clears BOTH attach sources and closes the boot attach window", () => {
  // The contract behind an explicit restart of a possibly-unmounted tab: the
  // next mount must plain-spawn. That requires clearing the confirmed-session
  // AND no-session markers, and keeping the boot-only attachIfReused intent
  // from firing again (mount decision counts as made).
  markSpawned("ss-fg");
  markNoSession("ss-fg");
  forgetSpawn("ss-fg");
  assert.equal(wasSpawned("ss-fg"), false);
  assert.equal(hadNoSession("ss-fg"), false);
  assert.equal(wasMountDecided("ss-fg"), true);
});
