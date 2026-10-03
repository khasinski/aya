// Staleness comparison for the detached PTY host (#28). A stale host is one
// from an older build than the app now in charge; the worst case (an old host
// that predates the version handshake) reports nothing -> null -> stale.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PTY_HOST_SCRIPT_NAME,
  RUN_AS_NODE_VALUE,
  RUN_AS_NODE_VAR,
  UNKNOWN_SCRIPT_HASH,
  isHostStale,
} from "../dist-electron/pty-host-staleness.js";

const FRESH = { version: "0.4.0", scriptHash: "abc123" };

// Pinned: old hosts and on-disk records carry these exact strings, and the
// sweep and the reaper's kill gate recognise a host by them.
test("the host's launch facts and hash sentinel keep their values", () => {
  assert.equal(UNKNOWN_SCRIPT_HASH, "unknown");
  assert.equal(PTY_HOST_SCRIPT_NAME, "pty-host.js");
  assert.equal(RUN_AS_NODE_VAR, "ELECTRON_RUN_AS_NODE");
  assert.equal(RUN_AS_NODE_VALUE, "1");
});

test("a null identity (handshake failed / old host) is stale", () => {
  assert.equal(isHostStale(FRESH, null), true);
});

// The "unknown" hash never decides a kill: a stale verdict restarts the host and every agent in it.
const UNKNOWN = UNKNOWN_SCRIPT_HASH;
const SENTINEL_TABLE = [
  // [name, expected, actual, stale]
  ["both hashes known and equal", "abc123", "abc123", false],
  ["both hashes known and different", "abc123", "abc124", true],
  ["the host's hash is unknown", "abc123", UNKNOWN, false],
  ["this app's hash is unknown", UNKNOWN, "abc123", false],
  ["both unknown", UNKNOWN, UNKNOWN, false],
];
for (const [name, expectedHash, actualHash, stale] of SENTINEL_TABLE) {
  for (const sameVersion of [true, false]) {
    // A different version is stale whatever the hashes say.
    const want = sameVersion ? stale : true;
    test(`${name}, ${sameVersion ? "same" : "different"} version: ${want ? "stale" : "kept"}`, () => {
      const expected = { version: "0.4.0", scriptHash: expectedHash };
      const actual = { version: sameVersion ? "0.4.0" : "0.3.0", scriptHash: actualHash };
      assert.equal(isHostStale(expected, actual), want);
    });
  }
}
