// What usage-grok.test.mjs leaves open: the scan of <home>/sessions/*/*/updates.jsonl
// that readGrokUsage sums (mtime gate, per-file cache, dedup, stray entries),
// the edge cases of one turn row, the GROK_HOME default, the limit picked
// across homes, and the tail read of a unified.jsonl bigger than the cap.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GROK_LIMIT_SCAN_MAX_BYTES,
  GROK_LIMIT_PARTIAL_MAX_BYTES,
  GROK_USAGE_TOTAL_SCAN_MAX_BYTES,
  GROK_USAGE_WINDOW_MS,
  extractGrokUsageRow,
  readGrokLimit,
  readGrokUsage,
  resetGrokUsageCache,
  sumGrokUsage,
} from "../dist-electron/usage-grok.js";

const NOW = Date.parse("2026-09-26T20:00:00.000Z");
const END = "2026-09-30T14:18:08.811132+00:00";

const turnLine = (tsMs, usage = {}) =>
  JSON.stringify({
    timestamp: tsMs,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "agent_turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsdTicks: 1000,
          modelUsage: { "grok-4.6-build": {} },
          ...usage,
        },
      },
      _meta: { agentTimestampMs: tsMs },
    },
  });

const creditsLine = (pct, ts) =>
  JSON.stringify({
    ts,
    msg: "billing: fetched credits config",
    ctx: { config: { creditUsagePercent: pct, currentPeriod: { end: END } } },
  });

function tempHome(t) {
  const home = mkdtempSync(join(tmpdir(), "aya-grok-more-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Writes <home>/sessions/<cwd>/<uuid>/updates.jsonl and returns its path. */
function session(home, cwd, uuid, lines) {
  const dir = join(home, "sessions", cwd, uuid);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "updates.jsonl");
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  return file;
}

// ---- one turn row ----------------------------------------------------------

test("a line that mentions usage but is not JSON is skipped", () => {
  assert.equal(extractGrokUsageRow('{"usage": {"inputTokens": 5'), null);
});
test("a usage field that is not an object is not a turn", () => {
  for (const usage of [5, null, "150"]) {
    const line = JSON.stringify({ timestamp: NOW, params: { update: { usage } } });
    assert.equal(extractGrokUsageRow(line), null);
  }
});

test("the turn time falls back to the top-level timestamp, and seconds become ms", () => {
  const secs = Math.floor(NOW / 1000);
  const line = JSON.stringify({ timestamp: secs, params: { update: { usage: { totalTokens: 7 } } } });
  assert.equal(extractGrokUsageRow(line).tsMs, secs * 1000);
  const metaSecs = JSON.stringify({
    timestamp: "not a number",
    params: { update: { usage: { totalTokens: 7 } }, _meta: { agentTimestampMs: secs } },
  });
  assert.equal(extractGrokUsageRow(metaSecs).tsMs, secs * 1000);
});

test("a turn with no usable time gets 0 and so falls outside any window", () => {
  const line = JSON.stringify({ params: { update: { usage: { totalTokens: 7 } } } });
  const row = extractGrokUsageRow(line);
  assert.equal(row.tsMs, 0);
  assert.equal(sumGrokUsage([row], NOW), null);
});

test("non-numeric counters count as 0 and a turn without modelUsage has no models", () => {
  const row = extractGrokUsageRow(
    turnLine(NOW, { cachedReadTokens: "20", reasoningTokens: null, costUsdTicks: Infinity, modelUsage: undefined }),
  );
  assert.equal(row.cachedReadTokens, 0);
  assert.equal(row.reasoningTokens, 0);
  assert.equal(row.costUsdTicks, 0);
  assert.deepEqual(row.models, []);
});

test("the window includes both of its ends, and a custom window is honoured", () => {
  const atStart = extractGrokUsageRow(turnLine(NOW - GROK_USAGE_WINDOW_MS));
  const atNow = extractGrokUsageRow(turnLine(NOW));
  assert.equal(sumGrokUsage([atStart, atNow], NOW).turns, 2);
  assert.equal(sumGrokUsage([atStart, atNow], NOW, 60_000).turns, 1);
});

// ---- the sessions scan -----------------------------------------------------

test("readGrokUsage sums every session under every cwd of a home", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  session(home, "-Users-me-a", "s1", [turnLine(NOW - 1000), '{"method":"tool_call"}']);
  session(home, "-Users-me-a", "s2", [turnLine(NOW - 2000, { modelUsage: { "grok-4-fast": {} } })]);
  session(home, "-Users-me-b", "s3", [turnLine(NOW - 3000)]);
  const usage = await readGrokUsage([home], NOW);
  assert.equal(usage.turns, 3);
  assert.equal(usage.totalTokens, 450);
  assert.equal(usage.costUsdTicks, 3000);
  assert.deepEqual(usage.models, ["grok-4-fast", "grok-4.6-build"]);
  assert.equal(usage.updatedAt, new Date(NOW - 1000).toISOString());
  assert.equal(usage.limit, undefined);
});

test("Grok usage reads a sparse 1 GiB session from a bounded tail", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  const file = session(home, "cwd", "sparse", []);
  const line = turnLine(NOW - 1000);
  const size = 1024 * 1024 * 1024;
  const fd = openSync(file, "w+");
  try {
    ftruncateSync(fd, size);
    const bytes = Buffer.from(`\n${line}\n`);
    writeSync(fd, bytes, 0, bytes.length, size - bytes.length);
  } finally {
    closeSync(fd);
  }
  const before = process.memoryUsage().rss;
  const usage = await readGrokUsage([home], NOW);
  const after = process.memoryUsage().rss;
  assert.equal(usage.turns, 1);
  assert.equal(usage.totalTokens, 150);
  assert.ok(after - before < 128 * 1024 * 1024, `RSS grew by ${after - before} bytes`);
});

test("a session log not written within the window is not read, whatever its rows say", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  const old = session(home, "cwd", "old", [turnLine(NOW - 1000)]);
  const oldSec = (NOW - GROK_USAGE_WINDOW_MS - 60_000) / 1000;
  utimesSync(old, oldSec, oldSec);
  assert.equal(await readGrokUsage([home], NOW), null);
});

test("stray entries under sessions/ are skipped without hiding the real sessions", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  session(home, "cwd", "real", [turnLine(NOW - 1000)]);
  writeFileSync(join(home, "sessions", "a-file-not-a-cwd"), "x");
  mkdirSync(join(home, "sessions", "cwd", "no-log"), { recursive: true });
  mkdirSync(join(home, "sessions", "cwd", "log-is-a-dir", "updates.jsonl"), { recursive: true });
  writeFileSync(join(home, "sessions", "cwd", "plain-file"), "x");
  const usage = await readGrokUsage([home], NOW);
  assert.equal(usage.turns, 1);
});

test("a home with no sessions dir, or none at all, gives null", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  assert.equal(await readGrokUsage([home, join(home, "missing")], NOW), null);
});

test("the same home listed twice is counted once", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  session(home, "cwd", "s1", [turnLine(NOW - 1000)]);
  const usage = await readGrokUsage([home, `${home}/`, join(home, "sessions", "..")], NOW);
  assert.equal(usage.turns, 1);
});

test("an unchanged mtime reuses the parsed rows until the cache is reset", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  const file = session(home, "cwd", "s1", [turnLine(NOW - 1000)]);
  // Whole seconds: an mtime read back from stat would lose its sub-ms part.
  const fixed = Math.floor(NOW / 1000) - 60;
  utimesSync(file, fixed, fixed);
  assert.equal((await readGrokUsage([home], NOW)).turns, 1);
  writeFileSync(file, `${turnLine(NOW - 1000)}\n${turnLine(NOW - 2000)}\n`);
  utimesSync(file, fixed, fixed);
  assert.equal((await readGrokUsage([home], NOW)).turns, 1, "same mtime: cached rows");
  resetGrokUsageCache();
  assert.equal((await readGrokUsage([home], NOW)).turns, 2, "after reset: reparsed");
});

test("an append that moves the mtime is picked up on the next poll", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  const file = session(home, "cwd", "s1", [turnLine(NOW - 1000)]);
  assert.equal((await readGrokUsage([home], NOW)).turns, 1);
  appendFileSync(file, `${turnLine(NOW - 500)}\n`);
  const later = statSync(file).mtimeMs / 1000 + 5;
  utimesSync(file, later, later);
  assert.equal((await readGrokUsage([home], NOW)).turns, 2);
});

test(
  "an unreadable session log adds nothing and the others still count",
  { skip: process.getuid?.() === 0 ? "root reads mode 000 files" : false },
  async (t) => {
    resetGrokUsageCache();
    const home = tempHome(t);
    const locked = session(home, "cwd", "locked", [turnLine(NOW - 1000)]);
    session(home, "cwd", "open", [turnLine(NOW - 2000)]);
    chmodSync(locked, 0o000);
    try {
      const usage = await readGrokUsage([home], NOW);
      assert.equal(usage.turns, 1);
      assert.equal(usage.updatedAt, new Date(NOW - 2000).toISOString());
    } finally {
      chmodSync(locked, 0o644);
    }
  },
);

test("across homes the limit logged last wins, whatever the order of the homes", async (t) => {
  const older = tempHome(t);
  const newer = tempHome(t);
  mkdirSync(join(older, "logs"));
  mkdirSync(join(newer, "logs"));
  writeFileSync(join(older, "logs", "unified.jsonl"), `${creditsLine(10, "2026-09-26T10:00:00.000Z")}\n`);
  writeFileSync(join(newer, "logs", "unified.jsonl"), `${creditsLine(60, "2026-09-26T19:00:00.000Z")}\n`);
  session(older, "cwd", "s1", [turnLine(NOW - 1000)]);
  resetGrokUsageCache();
  assert.equal((await readGrokUsage([newer, older], NOW)).limit.pct, 60);
  assert.equal((await readGrokUsage([older, newer], NOW)).limit.pct, 60);
  const usage = await readGrokUsage([older, newer], NOW);
  assert.equal(usage.turns, 1, "the turns stay summed next to the limit");
  assert.equal(usage.updatedAt, new Date(NOW - 1000).toISOString());
});

test("no homes means the default home, which GROK_HOME names", (t) => {
  const home = tempHome(t);
  session(home, "cwd", "s1", [turnLine(NOW - 1000)]);
  const moduleUrl = new URL("../dist-electron/usage-grok.js", import.meta.url).href;
  const script =
    `const m = await import(${JSON.stringify(moduleUrl)});` +
    `const u = await m.readGrokUsage([], ${NOW});` +
    `console.log(JSON.stringify({ home: m.DEFAULT_GROK_HOME, turns: u && u.turns }));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, GROK_HOME: home, HOME: home },
    encoding: "utf-8",
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { home, turns: 1 });
});

// ---- unified.jsonl bigger than the read cap ---------------------------------
// Sparse files: truncate() grows a file with zero bytes that take no disk.

function bigLog(t) {
  const home = tempHome(t);
  mkdirSync(join(home, "logs"));
  const log = join(home, "logs", "unified.jsonl");
  writeFileSync(log, "");
  return { home, log };
}
const growBy = (log, n) => truncateSync(log, statSync(log).size + n);

test("a log bigger than the cap is read from its tail: a credits line before it is not seen", async (t) => {
  const { home, log } = bigLog(t);
  writeFileSync(log, `${creditsLine(10, "2026-09-26T19:00:00.000Z")}\n`);
  growBy(log, GROK_LIMIT_SCAN_MAX_BYTES + 1024);
  appendFileSync(log, '\n{"msg":"other"}\n');
  assert.equal(await readGrokLimit(home, NOW), null);
});

test("the line the tail starts in is dropped, even when what is left of it parses", async (t) => {
  const { home, log } = bigLog(t);
  const pad = 1000;
  const line = `${" ".repeat(pad)}${creditsLine(20, "2026-09-26T19:00:00.000Z")}`;
  growBy(log, 1024 * 1024);
  appendFileSync(log, `\n${line}\n`);
  // Zero bytes after the line put the cap's start in the middle of its spaces.
  growBy(log, GROK_LIMIT_SCAN_MAX_BYTES - pad / 2 - (line.length - pad) - 2);
  appendFileSync(log, "\n");
  const start = statSync(log).size - GROK_LIMIT_SCAN_MAX_BYTES;
  const lineStart = 1024 * 1024 + 1;
  assert.ok(start > lineStart && start < lineStart + pad, "the cut lands in the padding");
  assert.equal(await readGrokLimit(home, NOW), null);
});

test("a partial line carried from the last poll is dropped when the next read skips ahead", async (t) => {
  const { home, log } = bigLog(t);
  writeFileSync(log, "garbage-without-newline");
  assert.equal(await readGrokLimit(home, NOW), null);
  growBy(log, GROK_LIMIT_SCAN_MAX_BYTES + 1024);
  appendFileSync(log, `\n${creditsLine(30, "2026-09-26T19:00:00.000Z")}\n`);
  assert.equal((await readGrokLimit(home, NOW)).pct, 30);
});

test("a tail with no newline yields nothing, and the next appended line is still read", async (t) => {
  const { home, log } = bigLog(t);
  growBy(log, GROK_LIMIT_SCAN_MAX_BYTES + 1024);
  assert.equal(await readGrokLimit(home, NOW), null);
  appendFileSync(log, `\n${creditsLine(40, "2026-09-26T19:00:00.000Z")}\n`);
  assert.equal((await readGrokLimit(home, NOW)).pct, 40);
});

test("an oversized growing partial credits line is dropped until the next newline", async (t) => {
  resetGrokUsageCache();
  const { home, log } = bigLog(t);
  writeFileSync(log, `${creditsLine(5, "2026-09-26T18:00:00.000Z")}\n`);
  let tSec = NOW / 1000;
  utimesSync(log, tSec, tSec);
  assert.equal((await readGrokLimit(home, NOW)).pct, 5);

  appendFileSync(log, "x".repeat(Math.floor(GROK_LIMIT_PARTIAL_MAX_BYTES * 0.7)));
  tSec += 1;
  utimesSync(log, tSec, tSec);
  assert.equal((await readGrokLimit(home, NOW)).pct, 5);

  appendFileSync(log, "x".repeat(Math.floor(GROK_LIMIT_PARTIAL_MAX_BYTES * 0.7)));
  tSec += 1;
  utimesSync(log, tSec, tSec);
  assert.equal((await readGrokLimit(home, NOW)).pct, 5);

  appendFileSync(log, `still-garbage\n${creditsLine(73, "2026-09-26T19:00:00.000Z")}\n`);
  tSec += 1;
  utimesSync(log, tSec, tSec);
  assert.equal((await readGrokLimit(home, NOW)).pct, 73);
});

test("Grok usage filters expired and future rows before per-file and total row caps", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  const future = turnLine(NOW + 60_000);

  // More than the per-file cap of out-of-window rows must not hide the valid
  // in-window row at the beginning of this transcript.
  session(home, "one-cwd", "per-file", [turnLine(NOW - 1000), ...Array(2001).fill(future)]);
  const perFile = await readGrokUsage([home], NOW);
  assert.equal(perFile.turns, 1);
  assert.equal(perFile.totalTokens, 150);

  resetGrokUsageCache();
  const totalHome = tempHome(t);
  for (let i = 0; i < 11; i += 1) {
    session(totalHome, `junk-${i}`, "session", Array(2000).fill(future));
  }
  session(totalHome, "valid", "session", [turnLine(NOW - 2000)]);
  const total = await readGrokUsage([totalHome], NOW);
  assert.equal(total.turns, 1);
  assert.equal(total.totalTokens, 150);
});

test("Grok usage reads at most the aggregate scan budget newest-first per poll", async (t) => {
  resetGrokUsageCache();
  const home = tempHome(t);
  const size = GROK_USAGE_TOTAL_SCAN_MAX_BYTES / 4;
  for (let i = 0; i < 5; i += 1) {
    const file = session(home, `large-cwd-${i}`, "session", []);
    const fd = openSync(file, "w+");
    try {
      ftruncateSync(fd, size);
      const row = Buffer.from(`\n${turnLine(NOW - 1000)}\n`);
      writeSync(fd, row, 0, row.length, size - row.length);
    } finally {
      closeSync(fd);
    }
  }
  const first = await readGrokUsage([home], NOW);
  assert.equal(first.turns, 4);
  assert.equal(first.totalTokens, 600);
  // The unscanned candidate is not cached as a complete parse, so it is read
  // on a later poll after cached candidates consume no IO budget.
  const second = await readGrokUsage([home], NOW);
  assert.equal(second.turns, 5);
  assert.equal(second.totalTokens, 750);
});
