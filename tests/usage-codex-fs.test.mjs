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
  openSync,
  ftruncateSync,
  writeSync,
  closeSync,
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
const noSnapshotLine =
  JSON.stringify({ payload: { type: "agent_message" } }) + "\n";

const older = join(sessions, "rollout-old.jsonl");
const newer = join(sessions, "rollout-new.jsonl");

const { DEFAULT_CODEX_HOME, readCodexUsageAccountsFromSources } =
  await import("../dist-electron/usage-codex.js");
const { resetCodexUsageCaches } = await import("../dist-electron/usage-codex.js");
const { CODEX_USAGE_TAIL_MAX_BYTES } = await import("../dist-electron/usage-codex.js");
const { MAX_CODEX_ACCOUNT_TEXT_CHARS } = await import("../dist-electron/usage-codex.js");

// SOURCES mirrors codexUsageSources([]); accounts[0] is this test's
// own adapter, standing in for the removed single-snapshot reader.
const SOURCES = [{ id: "codex", label: "Codex", home: DEFAULT_CODEX_HOME }];
const codexUsage = async () => {
  const accounts = await readCodexUsageAccountsFromSources(SOURCES);
  return accounts.length ? accounts[0].usage : null;
};

test("falls back to an older rollout when the newest has no snapshot", async () => {
  writeFileSync(older, snapshotLine(3, 12)); // older HAS a snapshot
  writeFileSync(newer, noSnapshotLine); // newest (by mtime) has none
  const t = Date.now() / 1000;
  utimesSync(older, t - 100, t - 100);
  utimesSync(newer, t, t);

  const u = await codexUsage();
  assert.equal(u.fiveHour.pct, 3); // from the older file's snapshot
  assert.equal(u.sevenDay.pct, 12);
});

test("returns null when no recent rollout has a snapshot", async () => {
  writeFileSync(older, noSnapshotLine);
  writeFileSync(newer, noSnapshotLine);
  assert.equal(await codexUsage(), null);
});

test("returns one newest snapshot per account across recent rollouts", async () => {
  writeFileSync(older, snapshotLine(3, 12, "work", "Work"));
  writeFileSync(newer, snapshotLine(7, 22, "personal", "Personal"));
  const t = Date.now() / 1000;
  utimesSync(older, t - 100, t - 100);
  utimesSync(newer, t, t);

  const out = await readCodexUsageAccountsFromSources(SOURCES);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "personal");
  assert.equal(out[0].usage.sevenDay.pct, 22);
  assert.equal(out[1].id, "work");
  assert.equal(out[1].usage.sevenDay.pct, 12);
});

test("uses source ids when separate CODEX_HOME logs do not expose account ids", async () => {
  writeFileSync(older, snapshotLine(3, 12));
  writeFileSync(newer, noSnapshotLine);
  writeFileSync(
    join(secondSessions, "rollout-second.jsonl"),
    snapshotLine(8, 20),
  );

  const out = await readCodexUsageAccountsFromSources([
    { id: "codex", label: "Codex", home: root },
    { id: "codex-2", label: "Codex 2", home: secondRoot },
  ]);

  assert.equal(out.length, 2);
  assert.equal(out[0].id, "codex");
  assert.equal(out[1].id, "codex-2");
});

test("a sparse 1 GiB rollout is read from its bounded tail", async () => {
  resetCodexUsageCaches();
  const root = mkdtempSync(join(tmpdir(), "aya-codex-sparse-"));
  const dir = join(root, "sessions", "2026", "10", "26");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-sparse.jsonl");
  const line = snapshotLine(17, 29, "sparse-account", "Sparse Account");
  const size = 1024 * 1024 * 1024;
  const fd = openSync(file, "w+");
  try {
    ftruncateSync(fd, size);
    const bytes = Buffer.from(`\n${line}`);
    writeSync(fd, bytes, 0, bytes.length, size - bytes.length);
  } finally {
    closeSync(fd);
  }
  try {
    const before = process.memoryUsage().rss;
    const accounts = await readCodexUsageAccountsFromSources([
      { id: "codex-sparse", label: "Sparse", home: root },
    ]);
    const after = process.memoryUsage().rss;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, "sparse-account");
    assert.equal(accounts[0].usage.fiveHour.pct, 17);
    assert.ok(after - before < 128 * 1024 * 1024, `RSS grew by ${after - before} bytes`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a truncated rollout with no tail snapshot preserves its previous same-file usage", async () => {
  resetCodexUsageCaches();
  const home = mkdtempSync(join(tmpdir(), "aya-codex-cached-truncated-"));
  const dir = join(home, "sessions", "2026", "10", "26");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-current.jsonl");
  try {
    writeFileSync(file, snapshotLine(41, 62, "current", "Current"));
    const t = Date.now() / 1000;
    utimesSync(file, t - 5, t - 5);
    const initial = await readCodexUsageAccountsFromSources([{ id: "codex", label: "Codex", home }]);
    assert.equal(initial.length, 1);
    assert.equal(initial[0].usage.fiveHour.pct, 41);

    const fd = openSync(file, "w+");
    try {
      const size = CODEX_USAGE_TAIL_MAX_BYTES + 64;
      ftruncateSync(fd, size);
      const oldSnapshot = Buffer.from(snapshotLine(9, 19, "current", "Current"));
      const tailNoise = Buffer.from(noSnapshotLine);
      writeSync(fd, oldSnapshot, 0, oldSnapshot.length, 0);
      writeSync(fd, tailNoise, 0, tailNoise.length, size - tailNoise.length);
    } finally {
      closeSync(fd);
    }
    utimesSync(file, t + 5, t + 5);

    const afterGrowth = await readCodexUsageAccountsFromSources([{ id: "codex", label: "Codex", home }]);
    assert.equal(afterGrowth.length, 1);
    assert.equal(afterGrowth[0].id, "current");
    assert.equal(afterGrowth[0].usage.fiveHour.pct, 41);
  } finally {
    rmSync(home, { recursive: true, force: true });
    resetCodexUsageCaches();
  }
});

test("a first read of a truncated rollout without a tail snapshot has no usage", async () => {
  resetCodexUsageCaches();
  const home = mkdtempSync(join(tmpdir(), "aya-codex-first-truncated-"));
  const dir = join(home, "sessions", "2026", "10", "26");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-current.jsonl");
  const fd = openSync(file, "w+");
  try {
    const size = CODEX_USAGE_TAIL_MAX_BYTES + 64;
    ftruncateSync(fd, size);
    const tailNoise = Buffer.from(noSnapshotLine);
    writeSync(fd, tailNoise, 0, tailNoise.length, size - tailNoise.length);
  } finally {
    closeSync(fd);
  }
  try {
    const accounts = await readCodexUsageAccountsFromSources([{ id: "codex", label: "Codex", home }]);
    assert.deepEqual(accounts, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    resetCodexUsageCaches();
  }
});

test("a truncated Codex tail merges cached accounts absent from its newer lines", async () => {
  resetCodexUsageCaches();
  const home = mkdtempSync(join(tmpdir(), "aya-codex-mixed-truncated-"));
  const dir = join(home, "sessions", "2026", "10", "26");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-mixed.jsonl");
  try {
    writeFileSync(file, [
      snapshotLine(11, 21, "account-a", "A"),
      snapshotLine(12, 22, "account-b", "B"),
    ].join(""));
    const t = Date.now() / 1000;
    utimesSync(file, t - 5, t - 5);
    const initial = await readCodexUsageAccountsFromSources([{ id: "codex", label: "Codex", home }]);
    assert.deepEqual(initial.map((account) => account.id).sort(), ["account-a", "account-b"]);

    const fd = openSync(file, "w+");
    try {
      const size = CODEX_USAGE_TAIL_MAX_BYTES + 128;
      ftruncateSync(fd, size);
      const oldA = Buffer.from(snapshotLine(13, 23, "account-a", "A"));
      const newestB = Buffer.from(`\n${snapshotLine(44, 54, "account-b", "B")}`);
      writeSync(fd, oldA, 0, oldA.length, 0);
      writeSync(fd, newestB, 0, newestB.length, size - newestB.length);
    } finally {
      closeSync(fd);
    }
    utimesSync(file, t + 5, t + 5);

    const accounts = await readCodexUsageAccountsFromSources([{ id: "codex", label: "Codex", home }]);
    assert.deepEqual(accounts.map((account) => account.id).sort(), ["account-a", "account-b"]);
    assert.equal(accounts.find((account) => account.id === "account-a").usage.fiveHour.pct, 11);
    assert.equal(accounts.find((account) => account.id === "account-b").usage.fiveHour.pct, 44);
  } finally {
    rmSync(home, { recursive: true, force: true });
    resetCodexUsageCaches();
  }
});

test("a rollout with 128 large account names caches only capped account text", async () => {
  resetCodexUsageCaches();
  const home = mkdtempSync(join(tmpdir(), "aya-codex-many-large-accounts-"));
  const dir = join(home, "sessions", "2026", "10", "26");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-accounts.jsonl");
  const lines = [];
  for (let i = 0; i < 128; i += 1) {
    lines.push(JSON.stringify({
      timestamp: "2026-10-26T11:00:00.000Z",
      payload: {
        type: "token_count",
        rate_limits: {
          account_id: `${i}-${"i".repeat(500)}`,
          account_label: `${i}-${"l".repeat(500)}`,
          primary: { used_percent: 4 },
          secondary: { used_percent: 8 },
        },
      },
    }));
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  try {
    const accounts = await readCodexUsageAccountsFromSources([{ id: "codex", label: "Codex", home }]);
    assert.equal(accounts.length, 128);
    assert.ok(accounts.every((account) => account.id.length <= MAX_CODEX_ACCOUNT_TEXT_CHARS));
    assert.ok(accounts.every((account) => account.label.length <= MAX_CODEX_ACCOUNT_TEXT_CHARS));
  } finally {
    rmSync(home, { recursive: true, force: true });
    resetCodexUsageCaches();
  }
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(secondRoot, { recursive: true, force: true });
});
