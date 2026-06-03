// Filesystem-level selection for Codex usage, isolated to a temp CODEX_HOME
// (the real ~/.codex is never read). Covers what the pure scan tests can't: the
// multi-file fallback — if the newest rollout (by mtime) has no rate-limit
// snapshot yet, an older one that does must still surface (the most likely
// production failure mode: a freshly-started Codex session).
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

const root = mkdtempSync(join(tmpdir(), "aya-codex-test-"));
process.env.CODEX_HOME = root;
const sessions = join(root, "sessions", "2026", "06", "03");
mkdirSync(sessions, { recursive: true });

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
const noSnapshotLine = JSON.stringify({ payload: { type: "agent_message" } }) + "\n";

const older = join(sessions, "rollout-old.jsonl");
const newer = join(sessions, "rollout-new.jsonl");

const { readCodexUsage } = await import("../dist-electron/usage-codex.js");

test("falls back to an older rollout when the newest has no snapshot", async () => {
  writeFileSync(older, snapshotLine(3, 12)); // older HAS a snapshot
  writeFileSync(newer, noSnapshotLine); // newest (by mtime) has none
  const t = Date.now() / 1000;
  utimesSync(older, t - 100, t - 100);
  utimesSync(newer, t, t);

  const u = await readCodexUsage();
  assert.equal(u.fiveHour.pct, 3); // from the older file's snapshot
  assert.equal(u.sevenDay.pct, 12);
});

test("returns null when no recent rollout has a snapshot", async () => {
  writeFileSync(older, noSnapshotLine);
  writeFileSync(newer, noSnapshotLine);
  assert.equal(await readCodexUsage(), null);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
