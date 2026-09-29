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

test("a matching identity is not stale", () => {
  assert.equal(isHostStale(FRESH, { version: "0.4.0", scriptHash: "abc123" }), false);
  // Guard against "always return false": one-character hash change must be stale.
  assert.equal(isHostStale(FRESH, { version: "0.4.0", scriptHash: "abc124" }), true);
});

test("a different version is stale", () => {
  assert.equal(
    isHostStale(FRESH, { version: "0.3.0", scriptHash: "abc123" }),
    true,
  );
});

test("same version but different script hash is stale (dev rebuild case)", () => {
  // The exact scenario a version-only check misses: 0.4.0 -> 0.4.0 with a
  // changed bundle. The hash catches it.
  assert.equal(
    isHostStale(FRESH, { version: "0.4.0", scriptHash: "DIFFERENT" }),
    true,
  );
});
