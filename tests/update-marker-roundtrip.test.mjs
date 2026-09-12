// The marker FILE end to end: the writer can emit a shape readPendingUpdate
// normalizes away (a numeric requestedAt becomes "", killing the grace window).
// AYA_HOME must be redirected BEFORE the import - paths.ts resolves it at load.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-update-marker-"));

const {
  PENDING_UPDATE_FILE,
  markPendingUpdateSync,
  markPendingUpdate,
  readPendingUpdate,
  clearPendingUpdate,
  diagnoseRelaunch,
  ROLLBACK_GRACE_MS,
} = await import("../dist-electron/update-recovery.js");

const onDisk = () => JSON.parse(readFileSync(PENDING_UPDATE_FILE, "utf8"));

test("the quit-path writer produces a marker the reader accepts", async () => {
  await clearPendingUpdate();
  markPendingUpdateSync("0.8.1");
  const marker = await readPendingUpdate();
  assert.equal(marker.targetVersion, "0.8.1");
  assert.equal(marker.attempts, 1);
  // A PARSEABLE date: readPendingUpdate normalizes a non-string to "", which
  // silently disables the grace window.
  assert.ok(
    !Number.isNaN(Date.parse(marker.requestedAt)),
    `requestedAt must round-trip as a parseable date, got ${JSON.stringify(marker.requestedAt)}`,
  );
  // ...and the grace window engages on those bytes.
  assert.equal(diagnoseRelaunch(marker, "0.8.0"), "none");
});

test("a second quit for the same version counts as a second attempt", async () => {
  await clearPendingUpdate();
  markPendingUpdateSync("0.8.1");
  const first = onDisk();
  // Past a clock tick: two sync calls land in the same millisecond, so a frozen
  // stamp would satisfy `>=` against itself and the mutant would survive.
  await new Promise((resolve) => setTimeout(resolve, 5));
  markPendingUpdateSync("0.8.1");
  const second = onDisk();
  assert.equal(first.attempts, 1);
  assert.equal(second.attempts, 2);
  // Each attempt is stamped for itself - a frozen stamp would deny every retry
  // its window and wipe ShipIt's cache under a live install.
  assert.notEqual(
    second.requestedAt,
    first.requestedAt,
    "a retry must be stamped for itself",
  );
  assert.ok(Date.parse(second.requestedAt) > Date.parse(first.requestedAt));
  // The count is what makes the retry judgeable despite the fresh stamp.
  assert.equal(
    diagnoseRelaunch(await readPendingUpdate(), "0.8.0"),
    "rolled-back",
  );
});

test("a new target version starts its own count", async () => {
  await clearPendingUpdate();
  markPendingUpdateSync("0.8.1");
  markPendingUpdateSync("0.8.1");
  markPendingUpdateSync("0.9.0");
  const marker = await readPendingUpdate();
  assert.equal(marker.targetVersion, "0.9.0");
  assert.equal(marker.attempts, 1);
  assert.equal(diagnoseRelaunch(marker, "0.8.0"), "none", "a fresh version gets its window");
});

test("the async in-app writer shares the same accounting", async () => {
  await clearPendingUpdate();
  await markPendingUpdate("0.8.1");
  assert.equal((await readPendingUpdate()).attempts, 1);
  await markPendingUpdate("0.8.1");
  assert.equal((await readPendingUpdate()).attempts, 2);
});

test("a corrupt marker file is replaced, not inherited", async () => {
  writeFileSync(PENDING_UPDATE_FILE, "{ not json");
  markPendingUpdateSync("0.8.1");
  const marker = await readPendingUpdate();
  assert.equal(marker.targetVersion, "0.8.1");
  assert.equal(marker.attempts, 1);
});

test("a marker from an older build (no attempts field) is upgraded in place", async () => {
  const stamp = new Date(Date.now() - ROLLBACK_GRACE_MS - 1_000).toISOString();
  writeFileSync(
    PENDING_UPDATE_FILE,
    JSON.stringify({ targetVersion: "0.8.1", requestedAt: stamp }) + "\n",
  );
  // Reading it treats the missing field as the first attempt...
  assert.equal((await readPendingUpdate()).attempts, 1);
  // ...and the next quit counts as the second, so it becomes judgeable.
  markPendingUpdateSync("0.8.1");
  assert.equal((await readPendingUpdate()).attempts, 2);
});

test("clearing removes the file so the next launch is a normal one", async () => {
  markPendingUpdateSync("0.8.1");
  await clearPendingUpdate();
  assert.equal(await readPendingUpdate(), null);
  assert.equal(diagnoseRelaunch(await readPendingUpdate(), "0.8.0"), "none");
});

test.after(() => {
  rmSync(process.env.AYA_HOME, { recursive: true, force: true });
});
