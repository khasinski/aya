// Usage limits in the Conversation GUI: Claude's detection in main, and the Limited state the renderer keeps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeUsageLimitTracker, claudeLimitMessage, resetFromLimitText } from "../dist-electron/gui-usage-limit.js";
import { isUsageLimitError, limitPaneStatus, limitStatusText, mergeCodexRateLimits, nextLimitEvent, parseUsageLimit, RESUME_GRACE_MS, turnUsageLimit, windowName } from "../dist-test/gui-limits.js";

const now = Date.UTC(2026, 10, 26, 12, 0, 0);
const inSeconds = (s) => Math.floor(now / 1000) + s;

test("a rejected rate_limit_event names the window and the reset of the turn's failure", () => {
  const tracker = new ClaudeUsageLimitTracker();
  tracker.observe({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", resetsAt: inSeconds(9000) } }, now);
  tracker.observe({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: inSeconds(3600) } }, now);
  const limit = tracker.limitFor({ type: "result", is_error: true, result: "You've hit your limit · resets 1pm" }, now);
  assert.deepEqual(limit, { resetsAt: inSeconds(3600) * 1000, window: "5-hour" });
  assert.equal(claudeLimitMessage(limit, "You've hit your limit · resets 1pm"), "You've hit your limit · resets 1pm");
  assert.equal(claudeLimitMessage(limit, ""), "Claude usage limit reached (5-hour limit).");
});

test("overage that is allowed does not limit the turn, and a successful result is never a limit", () => {
  const tracker = new ClaudeUsageLimitTracker();
  tracker.observe({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: inSeconds(60), overageStatus: "allowed" } }, now);
  assert.equal(tracker.limitFor({ is_error: true, result: "API Error: 500 Internal" }, now), null);
  tracker.observe({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: inSeconds(60) } }, now);
  assert.equal(tracker.limitFor({ is_error: false, result: "done" }, now), null);
  tracker.reset();
  assert.equal(tracker.limitFor({ is_error: true, result: "API Error: 500 Internal" }, now), null);
});

test("a blocked assistant message and the result text supply the reset when no event did", () => {
  const tracker = new ClaudeUsageLimitTracker();
  tracker.observe({ type: "assistant", error: "rate_limit", api_error_params: { rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus", resetsAt: inSeconds(120) } } }, now);
  assert.deepEqual(tracker.limitFor({ is_error: true, result: "" }, now), { resetsAt: inSeconds(120) * 1000, window: "7-day Opus" });
  const plain = new ClaudeUsageLimitTracker();
  assert.deepEqual(plain.limitFor({ is_error: true, result: `Claude AI usage limit reached|${inSeconds(600)}` }, now), { resetsAt: inSeconds(600) * 1000 });
  assert.deepEqual(plain.limitFor({ is_error: true, api_error_status: 429, result: "API Error: 429 (reset after 1h 5m)" }, now), { resetsAt: now + 65 * 60 * 1000 });
  assert.deepEqual(plain.limitFor({ is_error: true, result: "Rate limit reached" }, now), { resetsAt: null });
});

test("a clock time in the text resets today, or tomorrow once it has passed", () => {
  const local = new Date(2026, 10, 26, 14, 30).getTime();
  assert.equal(resetFromLimitText("resets 3pm (Europe/Warsaw)", local), new Date(2026, 10, 26, 15, 0).getTime());
  assert.equal(resetFromLimitText("resets at 9:15am", local), new Date(2026, 10, 27, 9, 15).getTime());
  assert.equal(resetFromLimitText("resets 5", local), null);
  assert.equal(resetFromLimitText("nothing here", local), null);
});

test("the renderer recognises Aya's Claude limit, Codex's error codes and limit text", () => {
  assert.deepEqual(turnUsageLimit({ status: "failed", error: { message: "Hit the limit", usageLimit: { resetsAt: now + 1000, window: "5-hour" } } }, null, now),
    { message: "Hit the limit", resetsAt: now + 1000, window: "5-hour" });
  const codex = mergeCodexRateLimits(null, { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: inSeconds(1800) }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: inSeconds(90000) } } });
  assert.deepEqual(turnUsageLimit({ error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } }, codex, now),
    { message: "You've hit your usage limit.", resetsAt: inSeconds(1800) * 1000, window: "5-hour" });
  // A sparse update keeps the windows it does not mention.
  const sparse = mergeCodexRateLimits(codex, { rateLimits: { primary: null, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: inSeconds(90000) } } });
  assert.equal(sparse.primary.usedPercent, 100);
  assert.equal(turnUsageLimit({ error: { message: "x", codexErrorInfo: "rateLimitExceeded" } }, sparse, now).window, "weekly");
  assert.deepEqual(turnUsageLimit({ error: { message: "Rate limit reached for requests" } }, null, now), { message: "Rate limit reached for requests", resetsAt: null });
  assert.equal(turnUsageLimit({ error: { message: "Sandbox denied", codexErrorInfo: "sandboxError" } }, codex, now), null);
  assert.equal(turnUsageLimit({ status: "completed" }, codex, now), null);
  assert.equal(isUsageLimitError({ error: { codexErrorInfo: "usageLimitExceeded" }, willRetry: false }), true);
  assert.equal(isUsageLimitError({ error: { codexErrorInfo: "usageLimitExceeded" }, willRetry: true }), false);
  assert.equal(windowName(60), "1-hour");
  assert.equal(windowName(null), undefined);
});

test("Limited reports an error until the reset; snoozed stays quiet; a passed reset is ready to continue", () => {
  const limit = { message: "Limit", resetsAt: now + 60_000, window: "5-hour" };
  assert.equal(limitPaneStatus(null, now), null);
  assert.equal(limitPaneStatus(limit, now).level, "error");
  assert.match(limitPaneStatus(limit, now).text, /^Limited · 5-hour limit resets /);
  assert.match(limitStatusText({ ...limit, resumeAtReset: true }, now), /^Limited · resumes at /);
  assert.equal(limitPaneStatus({ ...limit, snoozed: true }, now), "clear");
  assert.deepEqual(limitPaneStatus({ ...limit, snoozed: true }, now + 60_000), { level: "done", text: "Usage limit reset · ready to continue" });
  assert.equal(limitStatusText({ message: "x", resetsAt: null }, now), "Limited · reset time unknown");
});

test("the reset wakes the pane, then a scheduled resume follows after the grace period", () => {
  const limit = { message: "Limit", resetsAt: now + 60_000, resumeAtReset: true };
  assert.deepEqual(nextLimitEvent(limit, now), { action: "wake", inMs: 60_000 });
  assert.deepEqual(nextLimitEvent(limit, now + 60_000), { action: "resume", inMs: RESUME_GRACE_MS });
  assert.deepEqual(nextLimitEvent(limit, now + 600_000), { action: "resume", inMs: 0 });
  assert.equal(nextLimitEvent({ ...limit, resumeAtReset: false }, now + 60_000), null);
  assert.equal(nextLimitEvent({ message: "x", resetsAt: null }, now), null);
});

test("a saved limit is validated, and resume or snooze need a reset time", () => {
  assert.equal(parseUsageLimit(null), null);
  assert.equal(parseUsageLimit({ resetsAt: 5 }), null);
  assert.deepEqual(parseUsageLimit({ message: "m", resetsAt: 5, window: "5-hour", resumeAtReset: true, snoozed: true }), { message: "m", resetsAt: 5, window: "5-hour", resumeAtReset: true, snoozed: true });
  assert.deepEqual(parseUsageLimit({ message: "m", resetsAt: null, resumeAtReset: true, snoozed: true }), { message: "m", resetsAt: null });
});
