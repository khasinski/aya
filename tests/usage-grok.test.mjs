// Grok records no rate-limit % locally (unlike Claude/Codex) - only per-turn
// tokens + cost in ~/.grok/sessions/**/updates.jsonl. These pin the parse of a
// turn row and the rolling-7-day aggregate the chip shows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractGrokUsageRow,
  sumGrokUsage,
  GROK_USAGE_WINDOW_MS,
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
