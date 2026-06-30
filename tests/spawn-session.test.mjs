// Confirmed-session registry behind attach-only re-mounts. Keying on confirmed
// output (not the spawn request) is what avoids two bugs: a false "no-session"
// when an in-flight first spawn re-mounts, and a stuck-stopped tab when an
// explicit restart targets an unmounted terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markSpawned, wasSpawned, forgetSpawn } from "../dist-test/spawnSession.js";

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
