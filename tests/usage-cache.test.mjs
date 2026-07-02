// mtime-gated caching for the Claude usage snapshot files. The usage chip
// polls every 30s but the hook rewrites these files far less often, so an
// unchanged mtime must reuse the cached parse. Proof of "no re-read": rewrite
// the CONTENT but restore the exact mtime — the old numbers keep coming back;
// only an mtime change surfaces the new ones.
//
// AYA_HOME is redirected to a temp dir BEFORE the (dynamic) import so
// USAGE_FILE and the per-config-dir files resolve into the temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aya-usage-cache-test-"));
process.env.AYA_HOME = home;
mkdirSync(home, { recursive: true });

const T1 = 1_750_000_000;
const T2 = T1 + 10;

const snapshot = (p) =>
  JSON.stringify({
    fiveHour: { pct: p },
    sevenDay: { pct: p },
    updatedAt: "2026-06-03T14:32:00Z",
  });

const {
  readClaudeUsageAccounts,
  readUsageAccounts,
  claudeUsageFileForConfigDir,
  resetUsageFileCaches,
} = await import("../dist-electron/usage.js");

const configDir = mkdtempSync(join(tmpdir(), "aya-usage-cfg-"));
const source = [{ id: "acct", label: "Account", configDir }];
const usageFile = claudeUsageFileForConfigDir(configDir);

test("unchanged mtime returns the cached parse (content not re-read)", async () => {
  writeFileSync(usageFile, snapshot(30));
  utimesSync(usageFile, T1, T1);
  assert.equal((await readClaudeUsageAccounts(source))[0].usage.fiveHour.pct, 30);

  writeFileSync(usageFile, snapshot(60));
  utimesSync(usageFile, T1, T1); // restore mtime — must stay cached
  assert.equal((await readClaudeUsageAccounts(source))[0].usage.fiveHour.pct, 30);
});

test("an mtime change picks up the rewritten file", async () => {
  utimesSync(usageFile, T2, T2);
  assert.equal((await readClaudeUsageAccounts(source))[0].usage.fiveHour.pct, 60);
});

test("a deleted file drops out (and its cache entry with it)", async () => {
  rmSync(usageFile);
  assert.deepEqual(await readClaudeUsageAccounts(source), []);
  // Recreate with the SAME mtime as the cached entry had: a stale cache would
  // wrongly return 60, a properly dropped one re-reads and sees 45.
  writeFileSync(usageFile, snapshot(45));
  utimesSync(usageFile, T2, T2);
  assert.equal((await readClaudeUsageAccounts(source))[0].usage.fiveHour.pct, 45);
});

test("legacy USAGE_FILE path is cached the same way", async () => {
  const legacy = join(home, "usage.json");
  writeFileSync(legacy, JSON.stringify({ accounts: [{ id: "a", label: "A", usage: JSON.parse(snapshot(11)) }] }));
  utimesSync(legacy, T1, T1);
  assert.equal((await readUsageAccounts())[0].usage.fiveHour.pct, 11);

  writeFileSync(legacy, JSON.stringify({ accounts: [{ id: "a", label: "A", usage: JSON.parse(snapshot(99)) }] }));
  utimesSync(legacy, T1, T1); // restored mtime — cached
  assert.equal((await readUsageAccounts())[0].usage.fiveHour.pct, 11);

  resetUsageFileCaches(); // reset hook forces a re-read
  assert.equal((await readUsageAccounts())[0].usage.fiveHour.pct, 99);
});

test.after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});
