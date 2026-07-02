// Poll-to-poll caching for Codex rollout scanning, isolated to a temp
// CODEX_HOME. The renderer polls every 30s, so steady-state polls must reuse
// the cached parse instead of re-reading full JSONL files. The proof for "no
// re-read" is: rewrite the CONTENT but restore the exact mtime — a cached poll
// keeps returning the old numbers; only an mtime change surfaces the new ones.
//
// CODEX_HOME is set BEFORE importing the module so its load-time path resolves
// into the temp dir; Node isolates each test file in its own process.

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

const root = mkdtempSync(join(tmpdir(), "aya-codex-cache-test-"));
process.env.CODEX_HOME = root;
const sessions = join(root, "sessions", "2026", "06", "03");
mkdirSync(sessions, { recursive: true });

// Fixed timestamps (seconds) so mtimes can be restored/advanced exactly.
const T1 = 1_750_000_000;
const T2 = T1 + 10;
const T3 = T1 + 20;

const snapshotLine = (p, s) =>
  JSON.stringify({
    timestamp: "2026-06-03T11:00:00.000Z",
    payload: {
      type: "token_count",
      rate_limits: {
        primary: { used_percent: p },
        secondary: { used_percent: s },
      },
    },
  }) + "\n";

const fileA = join(sessions, "rollout-a.jsonl");
const fileB = join(sessions, "rollout-b.jsonl");

const { readCodexUsage, readCodexUsageAccounts, resetCodexUsageCaches } =
  await import("../dist-electron/usage-codex.js");

test("unchanged mtime returns the cached parse (content not re-read)", async () => {
  writeFileSync(fileA, snapshotLine(10, 20));
  utimesSync(fileA, T1, T1);
  assert.equal((await readCodexUsage()).fiveHour.pct, 10);

  // Rewrite the content but restore the exact mtime: a cached poll must NOT
  // see the new numbers — proving the file wasn't re-read.
  writeFileSync(fileA, snapshotLine(50, 60));
  utimesSync(fileA, T1, T1);
  assert.equal((await readCodexUsage()).fiveHour.pct, 10);

  // Both read paths share the parse cache.
  const accounts = await readCodexUsageAccounts();
  assert.equal(accounts[0].usage.fiveHour.pct, 10);
});

test("an mtime change invalidates the cached parse", async () => {
  // Same content as before, only the mtime moves — must re-read and surface
  // the rewritten numbers.
  utimesSync(fileA, T2, T2);
  assert.equal((await readCodexUsage()).fiveHour.pct, 50);
});

test("a NEW rollout file is discovered within one poll", async () => {
  writeFileSync(fileB, snapshotLine(70, 80));
  utimesSync(fileB, T3, T3);
  assert.equal((await readCodexUsage()).fiveHour.pct, 70);
});

test("a deleted rollout drops out of the cache", async () => {
  rmSync(fileB);
  // Falls back to the remaining (cached) rollout, not the deleted one.
  assert.equal((await readCodexUsage()).fiveHour.pct, 50);
});

test("resetCodexUsageCaches forces a full re-read", async () => {
  writeFileSync(fileA, snapshotLine(90, 95));
  utimesSync(fileA, T2, T2); // restored mtime — cached without a reset
  resetCodexUsageCaches();
  assert.equal((await readCodexUsage()).fiveHour.pct, 90);
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
