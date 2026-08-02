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
const secondRoot = mkdtempSync(join(tmpdir(), "aya-codex-test-2-"));
process.env.CODEX_HOME = root;
const sessions = join(root, "sessions", "2026", "06", "03");
mkdirSync(sessions, { recursive: true });
const secondSessions = join(secondRoot, "sessions", "2026", "06", "03");
mkdirSync(secondSessions, { recursive: true });

const snapshotLine = (p, s, accountId = undefined, accountLabel = undefined) =>
  JSON.stringify({
    timestamp: "2026-06-03T11:00:00.000Z",
    payload: {
      type: "token_count",
      ...(accountId ? { account_id: accountId } : {}),
      ...(accountLabel ? { account_label: accountLabel } : {}),
      rate_limits: {
        primary: { used_percent: p },
        secondary: { used_percent: s },
      },
    },
  }) + "\n";
const noSnapshotLine = JSON.stringify({ payload: { type: "agent_message" } }) + "\n";

const older = join(sessions, "rollout-old.jsonl");
const newer = join(sessions, "rollout-new.jsonl");

const { readCodexUsage, readCodexUsageAccounts, readCodexUsageAccountsFromSources } =
  await import("../dist-electron/usage-codex.js");

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

test("returns one newest snapshot per account across recent rollouts", async () => {
  writeFileSync(older, snapshotLine(3, 12, "work", "Work"));
  writeFileSync(newer, snapshotLine(7, 22, "personal", "Personal"));
  const t = Date.now() / 1000;
  utimesSync(older, t - 100, t - 100);
  utimesSync(newer, t, t);

  const out = await readCodexUsageAccounts();
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "personal");
  assert.equal(out[0].usage.sevenDay.pct, 22);
  assert.equal(out[1].id, "work");
  assert.equal(out[1].usage.sevenDay.pct, 12);
});

test("uses source ids when separate CODEX_HOME logs do not expose account ids", async () => {
  writeFileSync(older, snapshotLine(3, 12));
  writeFileSync(newer, noSnapshotLine);
  writeFileSync(join(secondSessions, "rollout-second.jsonl"), snapshotLine(8, 20));

  const out = await readCodexUsageAccountsFromSources([
    { id: "codex", label: "Codex", home: root },
    { id: "codex-2", label: "Codex 2", home: secondRoot },
  ]);

  assert.equal(out.length, 2);
  assert.equal(out[0].id, "codex");
  assert.equal(out[1].id, "codex-2");
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(secondRoot, { recursive: true, force: true });
});
