// Grok records no rate-limit % locally (unlike Claude/Codex) - only per-turn
// tokens + cost in ~/.grok/sessions/**/updates.jsonl. These pin the parse of a
// turn row and the rolling-7-day aggregate the chip shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractGrokUsageRow,
  sumGrokUsage,
  GROK_USAGE_WINDOW_MS,
  SECONDS_EPOCH_CEILING,
} from "../dist-electron/usage-grok.js";

const TS = Date.parse("2026-09-20T12:00:00.000Z");

const turnLine = (over = {}, tsMs = TS) =>
  JSON.stringify({
    timestamp: tsMs,
    method: "session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedReadTokens: 20,
          cacheCreationTokens: 0,
          reasoningTokens: 10,
          costUsdTicks: 42_000_000, // $0.0042
          modelUsage: { "grok-4.6-build": { calls: 1 } },
          ...over,
        },
      },
      _meta: { agentTimestampMs: tsMs },
    },
  });

test("extractGrokUsageRow pulls tokens, cost, model and time from a turn row", () => {
  const r = extractGrokUsageRow(turnLine());
  assert.ok(r);
  assert.equal(r.inputTokens, 100);
  assert.equal(r.outputTokens, 50);
  assert.equal(r.totalTokens, 150);
  assert.equal(r.cachedReadTokens, 20);
  assert.equal(r.reasoningTokens, 10);
  assert.equal(r.costUsdTicks, 42_000_000);
  assert.deepEqual(r.models, ["grok-4.6-build"]);
  assert.equal(r.tsMs, TS);
});

test("a line with no usage object is skipped (tool call, content, etc.)", () => {
  const toolLine = JSON.stringify({
    timestamp: TS,
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call", toolCallId: "t1" } },
  });
  assert.equal(extractGrokUsageRow(toolLine), null);
  assert.equal(extractGrokUsageRow('{"not":"json"'), null);
  assert.equal(extractGrokUsageRow(""), null);
});

test("a usage row with no tokens at all is not counted", () => {
  const empty = turnLine({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(extractGrokUsageRow(empty), null);
});

test("totalTokens falls back to input+output when the field is absent", () => {
  const line = JSON.stringify({
    timestamp: TS,
    params: {
      update: { usage: { inputTokens: 30, outputTokens: 20, costUsdTicks: 0 } },
      _meta: { agentTimestampMs: TS },
    },
  });
  assert.equal(extractGrokUsageRow(line).totalTokens, 50);
});

test("sumGrokUsage aggregates rows inside the window and sets updatedAt to the newest", () => {
  const rows = [
    extractGrokUsageRow(turnLine({}, TS - 60_000)),
    extractGrokUsageRow(turnLine({}, TS - 30_000)),
  ];
  const agg = sumGrokUsage(rows, TS);
  assert.ok(agg);
  assert.equal(agg.turns, 2);
  assert.equal(agg.totalTokens, 300);
  assert.equal(agg.costUsdTicks, 84_000_000);
  assert.deepEqual(agg.models, ["grok-4.6-build"]);
  // Newest counted turn, not "now".
  assert.equal(agg.updatedAt, new Date(TS - 30_000).toISOString());
});

test("rows older than the window or in the future are excluded", () => {
  const stale = extractGrokUsageRow(turnLine({}, TS - GROK_USAGE_WINDOW_MS - 1));
  const future = extractGrokUsageRow(turnLine({}, TS + 60_000));
  assert.equal(sumGrokUsage([stale, future], TS), null);
});

test("distinct models across rows are merged and sorted", () => {
  const a = extractGrokUsageRow(
    turnLine({ modelUsage: { "grok-4.6-build": {} } }, TS - 1000),
  );
  const b = extractGrokUsageRow(
    turnLine({ modelUsage: { "grok-4-fast": {} } }, TS - 2000),
  );
  assert.deepEqual(sumGrokUsage([a, b], TS).models, ["grok-4-fast", "grok-4.6-build"]);
});

// The weekly limit comes from the "billing: fetched credits config" line Grok
// 1.0.41 writes to logs/unified.jsonl; the chip's ring shows it.
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractGrokLimit,
  readGrokLimit,
  readGrokUsage,
} from "../dist-electron/usage-grok.js";

const creditsLine = (pct, end, ts = "2026-09-26T19:48:33.830Z") =>
  JSON.stringify({
    ts,
    src: "shell",
    lvl: "info",
    msg: "billing: fetched credits config",
    ctx: {
      config: {
        creditUsagePercent: pct,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-09-23T14:18:08.811132+00:00",
          end,
        },
        onDemandCap: { val: 0 },
      },
    },
  });
const END = "2026-09-30T14:18:08.811132+00:00";
const NOW = Date.parse("2026-09-26T20:00:00Z");

test("extractGrokLimit reads percent, reset and log time from a credits line", () => {
  assert.deepEqual(extractGrokLimit(creditsLine(47, END)), {
    pct: 47,
    resetsAt: END,
    updatedAt: "2026-09-26T19:48:33.830Z",
  });
});

test("extractGrokLimit rejects other lines and changed shapes", () => {
  assert.equal(extractGrokLimit('{"msg":"slash.advertise","ctx":{}}'), null);
  assert.equal(extractGrokLimit("billing: fetched credits config (not json)"), null);
  assert.equal(extractGrokLimit(creditsLine("47", END)), null);
  assert.equal(extractGrokLimit(creditsLine(47, "soon")), null);
  assert.equal(extractGrokLimit(creditsLine(47, END, "later")), null);
  const moved = JSON.parse(creditsLine(47, END));
  moved.msg = "billing: fetched something else, mentioning billing: fetched credits config";
  assert.equal(extractGrokLimit(JSON.stringify(moved)), null);
});

function grokHome(lines) {
  const home = mkdtempSync(join(tmpdir(), "aya-grok-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "logs", "unified.jsonl"), `${lines.join("\n")}\n`);
  return home;
}

test("readGrokLimit takes the newest credits line", async () => {
  const home = grokHome([creditsLine(30, END, "2026-09-25T14:06:44Z"), creditsLine(47, END)]);
  try {
    assert.equal((await readGrokLimit(home, NOW)).pct, 47);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokLimit: a finished week is not this week's usage", async () => {
  const home = grokHome([creditsLine(99, "2026-09-23T14:18:08Z")]);
  try {
    assert.equal(await readGrokLimit(home, NOW), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokLimit: no log, or no credits line, is null", async () => {
  const empty = mkdtempSync(join(tmpdir(), "aya-grok-"));
  const other = grokHome(['{"msg":"slash.advertise"}']);
  try {
    assert.equal(await readGrokLimit(empty, NOW), null);
    assert.equal(await readGrokLimit(other, NOW), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("readGrokLimit finds a credits line far back in a big log", async () => {
  const home = grokHome([creditsLine(12, END), "x".repeat(3 * 1024 * 1024)]);
  try {
    assert.equal((await readGrokLimit(home, NOW)).pct, 12);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokLimit reads appended lines, including one split across polls", async () => {
  const home = grokHome([creditsLine(30, END, "2026-09-25T14:06:44Z")]);
  const log = join(home, "logs", "unified.jsonl");
  try {
    assert.equal((await readGrokLimit(home, NOW)).pct, 30);
    const next = `${creditsLine(47, END)}\n`;
    appendFileSync(log, next.slice(0, 40));
    assert.equal((await readGrokLimit(home, NOW)).pct, 30);
    appendFileSync(log, next.slice(40));
    assert.equal((await readGrokLimit(home, NOW)).pct, 47);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokLimit starts over when the log is rotated", async () => {
  const home = grokHome([creditsLine(80, END), "x".repeat(2000)]);
  const log = join(home, "logs", "unified.jsonl");
  try {
    assert.equal((await readGrokLimit(home, NOW)).pct, 80);
    writeFileSync(log, `${creditsLine(5, END)}\n`);
    assert.equal((await readGrokLimit(home, NOW)).pct, 5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokUsage carries the limit even with no turns in the window", async () => {
  const home = grokHome([creditsLine(47, END)]);
  try {
    const usage = await readGrokUsage([home], NOW);
    assert.equal(usage.turns, 0);
    assert.deepEqual(usage.limit, { pct: 47, resetsAt: END, updatedAt: "2026-09-26T19:48:33.830Z" });
    assert.equal(usage.updatedAt, "2026-09-26T19:48:33.830Z");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokUsage without a limit or turns stays null (the chip hides)", async () => {
  const home = grokHome(['{"msg":"other"}']);
  try {
    assert.equal(await readGrokUsage([home], NOW), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokLimit rereads a log replaced by a file at least as big", async () => {
  const home = grokHome([creditsLine(80, END), "x".repeat(2000)]);
  const log = join(home, "logs", "unified.jsonl");
  try {
    assert.equal((await readGrokLimit(home, NOW)).pct, 80);
    writeFileSync(`${log}.new`, `${creditsLine(5, END)}\n${"y".repeat(3000)}\n`);
    renameSync(`${log}.new`, log);
    assert.equal((await readGrokLimit(home, NOW)).pct, 5);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readGrokLimit keeps the last limit through a passing read error", async () => {
  const home = grokHome([creditsLine(80, END)]);
  const log = join(home, "logs", "unified.jsonl");
  try {
    assert.equal((await readGrokLimit(home, NOW)).pct, 80);
    chmodSync(log, 0o000);
    assert.equal((await readGrokLimit(home, NOW)).pct, 80);
  } finally {
    chmodSync(log, 0o644);
    rmSync(home, { recursive: true, force: true });
  }
});

test("a huge or long-unread log is read from its tail, never whole", async () => {
  // The first poll starts at offset 0; a weeks-old unified.jsonl must not be
  // pulled into the main process in one read.
  const { limitScanWindow, GROK_LIMIT_SCAN_MAX_BYTES } = await import(
    "../dist-electron/usage-grok.js"
  );
  assert.deepEqual(limitScanWindow(0, 1000, 4096), { start: 0, cut: false });
  assert.deepEqual(limitScanWindow(500, 1000, 4096), { start: 500, cut: false });
  assert.deepEqual(limitScanWindow(0, 10_000, 4096), { start: 10_000 - 4096, cut: true });
  // Default cap is bounded (tens of MB, not unbounded).
  assert.ok(GROK_LIMIT_SCAN_MAX_BYTES > 0 && GROK_LIMIT_SCAN_MAX_BYTES <= 64 * 1024 * 1024);
});

test("timestamps below 1e12 are read as seconds", () => {
  assert.equal(SECONDS_EPOCH_CEILING, 1e12);
});
