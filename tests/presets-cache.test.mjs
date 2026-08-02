// mtime-gated caching of presets.json. Both usage handlers call listPresets on
// every 30s poll, so an unchanged file must reuse the cached parse (one stat,
// no read). Gating on mtime — not save-invalidation alone — means hand-edits
// to presets.json are still picked up. Proof of "no re-read": rewrite the
// CONTENT but restore the exact mtime — the old presets keep coming back.
//
// AYA_HOME is redirected to a temp dir BEFORE the (dynamic) import so
// PRESETS_FILE resolves into the temp dir; presets.json is seeded up front so
// the first-launch harness scan never runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aya-presets-cache-test-"));
process.env.AYA_HOME = home;
const presetsFile = join(home, "presets.json");

const T1 = 1_750_000_000;
const T2 = T1 + 10;

const preset = (id) => ({ id, name: id, icon: "$", color: "", command: id });
const writePresets = (ids) =>
  writeFileSync(presetsFile, JSON.stringify({ presets: ids.map(preset) }));

const { listPresets, savePresets, resetPresetsCache } = await import(
  "../dist-electron/presets.js"
);

test("unchanged mtime returns the cached parse (content not re-read)", async () => {
  writePresets(["one"]);
  utimesSync(presetsFile, T1, T1);
  assert.deepEqual((await listPresets()).map((p) => p.id), ["one"]);

  writePresets(["two"]);
  utimesSync(presetsFile, T1, T1); // restore mtime — must stay cached
  assert.deepEqual((await listPresets()).map((p) => p.id), ["one"]);
});

test("an mtime change (e.g. a hand-edit) is picked up", async () => {
  utimesSync(presetsFile, T2, T2);
  assert.deepEqual((await listPresets()).map((p) => p.id), ["two"]);
});

test("callers get a copy — mutating the result can't poison later polls", async () => {
  const first = await listPresets();
  first.length = 0;
  assert.deepEqual((await listPresets()).map((p) => p.id), ["two"]);
});

test("savePresets invalidates the cache immediately", async () => {
  await savePresets([preset("three")]);
  // Pin the saved file's mtime to the previously cached one: a stale cache
  // would keep returning "two".
  utimesSync(presetsFile, T2, T2);
  assert.deepEqual((await listPresets()).map((p) => p.id), ["three"]);
});

test("resetPresetsCache forces a re-read", async () => {
  writePresets(["four"]);
  utimesSync(presetsFile, T2, T2); // restored mtime — cached without a reset
  resetPresetsCache();
  assert.deepEqual((await listPresets()).map((p) => p.id), ["four"]);
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
});
