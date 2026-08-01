// Codex usage comes from the local rollout JSONL (a token_count event carries a
// rate_limits object + the line's own ISO timestamp). These pin the pure
// mapping + scan; the fs-level selection is covered in usage-codex-fs.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  codexUsageFromRateLimit,
  latestUsageAccountsFromLines,
  latestUsageFromLines,
} from "../dist-electron/usage-codex.js";

// The real shape captured from ~/.codex/sessions/.../rollout-*.jsonl.
const SAMPLE = {
  limit_id: "codex",
  primary: { used_percent: 1.0, window_minutes: 300, resets_at: 1780523078 },
  secondary: { used_percent: 25.0, window_minutes: 10080, resets_at: 1780851308 },
  plan_type: "plus",
};

const line = (timestamp, rate_limits) =>
  JSON.stringify({ timestamp, payload: { type: "token_count", rate_limits } });

const accountLine = (timestamp, account_id, account_label, primary, secondary) =>
  JSON.stringify({
    timestamp,
    payload: {
      type: "token_count",
      account_id,
      account_label,
      rate_limits: {
        primary: { used_percent: primary },
        secondary: { used_percent: secondary },
      },
    },
  });

test("maps primary->5h and secondary->weekly used_percent + resets", () => {
  const u = codexUsageFromRateLimit(SAMPLE, 1780000000000);
  assert.equal(u.fiveHour.pct, 1.0);
  assert.equal(u.sevenDay.pct, 25.0);
  assert.equal(u.updatedAt, new Date(1780000000000).toISOString());
  assert.equal(u.fiveHour.resetsAt, new Date(1780523078 * 1000).toISOString());
  assert.equal(u.sevenDay.resetsAt, new Date(1780851308 * 1000).toISOString());
});

test("does NOT swap the windows (5h is primary, not the weekly 25%)", () => {
  const u = codexUsageFromRateLimit(SAMPLE, 0);
  assert.equal(u.fiveHour.pct, 1.0);
  assert.equal(u.sevenDay.pct, 25.0);
});

test("a single valid window is a VALID snapshot (newer Codex plans have one)", () => {
  // Contract change (the chip used to vanish on these): one finite window
  // suffices. Position decides the ring when window_minutes is absent.
  const only5h = codexUsageFromRateLimit({ primary: { used_percent: 1 } }, 0);
  assert.equal(only5h.fiveHour.pct, 1);
  assert.equal(only5h.sevenDay, undefined);
  // An invalid sibling window is dropped, not fatal:
  const bad5h = codexUsageFromRateLimit(
    { primary: { used_percent: "1" }, secondary: { used_percent: 2 } },
    0,
  );
  assert.equal(bad5h.fiveHour, undefined);
  assert.equal(bad5h.sevenDay.pct, 2);
  const nan5h = codexUsageFromRateLimit(
    { primary: { used_percent: NaN }, secondary: { used_percent: 2 } },
    0,
  );
  assert.equal(nan5h.fiveHour, undefined);
  assert.equal(nan5h.sevenDay.pct, 2);
});

test("null only when NO window carries a finite used_percent", () => {
  assert.equal(codexUsageFromRateLimit({ primary: {}, secondary: null }, 0), null);
  assert.equal(
    codexUsageFromRateLimit(
      { primary: { used_percent: "x" }, secondary: { used_percent: NaN } },
      0,
    ),
    null,
  );
});

test("REAL new-schema payload: secondary null, weekly primary -> week ring only", () => {
  // Verbatim shape observed live on 2026-08-01 (plan_type plus): the chip
  // disappeared because the old parser demanded a secondary window.
  const u = codexUsageFromRateLimit(
    {
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 0.0, window_minutes: 10080, resets_at: 1786182650 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: "0" },
      plan_type: "plus",
    },
    1780000000000,
  );
  assert.equal(u.fiveHour, undefined, "no short window in the new schema");
  assert.equal(u.sevenDay.pct, 0, "zero percent is a VALUE, not absence");
  assert.equal(u.sevenDay.resetsAt, new Date(1786182650 * 1000).toISOString());
});

test("two same-class windows: the extra is DROPPED, never relabeled as the other ring", () => {
  const u = codexUsageFromRateLimit(
    {
      primary: { used_percent: 3, window_minutes: 300 },
      secondary: { used_percent: 9, window_minutes: 60 }, // also short -> conflict
    },
    0,
  );
  assert.equal(u.fiveHour.pct, 3, "first short window keeps the 5h ring");
  assert.equal(u.sevenDay, undefined, "the extra short window must NOT masquerade as weekly");
});

test("window_minutes outranks position: a short secondary renders as the 5h ring", () => {
  const u = codexUsageFromRateLimit(
    {
      primary: { used_percent: 30, window_minutes: 10080 },
      secondary: { used_percent: 7, window_minutes: 300 },
    },
    0,
  );
  assert.equal(u.fiveHour.pct, 7);
  assert.equal(u.sevenDay.pct, 30);
});

test("null for null / non-object", () => {
  assert.equal(codexUsageFromRateLimit(null, 0), null);
  assert.equal(codexUsageFromRateLimit(42, 0), null);
});

test("resetsAt accepts only Unix seconds; absent/other types omit it", () => {
  const u = codexUsageFromRateLimit(
    { primary: { used_percent: 1, resets_at: "2026-01-01" }, secondary: { used_percent: 2 } },
    0,
  );
  assert.equal(u.fiveHour.resetsAt, undefined); // ISO string is not seconds → dropped
  assert.equal(u.sevenDay.resetsAt, undefined); // absent
});

test("latestUsageFromLines uses the NEWEST complete snapshot + its timestamp", () => {
  const lines = [
    line("2026-06-03T10:00:00.000Z", { primary: { used_percent: 5 }, secondary: { used_percent: 10 } }),
    line("2026-06-03T11:00:00.000Z", SAMPLE),
  ];
  const u = latestUsageFromLines(lines, 0);
  assert.equal(u.fiveHour.pct, 1.0); // the newer line's value
  assert.equal(u.updatedAt, "2026-06-03T11:00:00.000Z"); // the line's own timestamp
});

test("latestUsageFromLines skips a VALUELESS trailing snapshot for an earlier valid one", () => {
  const lines = [
    line("2026-06-03T10:00:00.000Z", { primary: { used_percent: 5 }, secondary: { used_percent: 10 } }),
    line("2026-06-03T11:00:00.000Z", { primary: {}, secondary: null }), // nothing renderable
  ];
  const u = latestUsageFromLines(lines, 0);
  assert.equal(u.fiveHour.pct, 5); // fell back to the earlier valid snapshot
  assert.equal(u.sevenDay.pct, 10);
});

test("latestUsageFromLines: a trailing SINGLE-window snapshot wins (it is complete now)", () => {
  const lines = [
    line("2026-06-03T10:00:00.000Z", { primary: { used_percent: 5 }, secondary: { used_percent: 10 } }),
    line("2026-06-03T11:00:00.000Z", { primary: { used_percent: 9 } }),
  ];
  const u = latestUsageFromLines(lines, 0);
  assert.equal(u.fiveHour.pct, 9);
  assert.equal(u.sevenDay, undefined);
  assert.equal(u.updatedAt, "2026-06-03T11:00:00.000Z");
});

test("latestUsageFromLines falls back to fallbackMs when the line has no timestamp", () => {
  const lines = [JSON.stringify({ payload: { type: "token_count", rate_limits: SAMPLE } })];
  const u = latestUsageFromLines(lines, 1780000000000);
  assert.equal(u.updatedAt, new Date(1780000000000).toISOString());
});

test("latestUsageFromLines tolerates malformed lines; null when none", () => {
  assert.equal(latestUsageFromLines(["not json {", "", '{"payload":{}}'], 0), null);
  const lines = ["{ broken", line("2026-06-03T11:00:00.000Z", SAMPLE), "also broken {"];
  assert.equal(latestUsageFromLines(lines, 0).fiveHour.pct, 1.0);
});

test("latestUsageAccountsFromLines returns the newest complete snapshot per account", () => {
  const lines = [
    accountLine("2026-06-03T10:00:00.000Z", "work", "Work", 5, 10),
    accountLine("2026-06-03T10:05:00.000Z", "personal", "Personal", 8, 20),
    accountLine("2026-06-03T11:00:00.000Z", "work", "Work", 3, 12),
    accountLine("2026-06-03T12:00:00.000Z", "personal", "Personal", 9, 21),
  ];
  const out = latestUsageAccountsFromLines(lines, 0);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "personal");
  assert.equal(out[0].usage.sevenDay.pct, 21);
  assert.equal(out[1].id, "work");
  assert.equal(out[1].usage.fiveHour.pct, 3);
});

test("latestUsageAccountsFromLines falls back to one default account when no id is logged", () => {
  const out = latestUsageAccountsFromLines([line("2026-06-03T11:00:00.000Z", SAMPLE)], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "default");
  assert.equal(out[0].label, "Account");
});

test("latestUsageAccountsFromLines reads account id from rate_limits.account_id", () => {
  const inRateLimits = JSON.stringify({
    timestamp: "2026-06-03T11:00:00.000Z",
    payload: {
      type: "token_count",
      rate_limits: {
        account_id: "work-123",
        account_label: "Work",
        primary: { used_percent: 4 },
        secondary: { used_percent: 8 },
      },
    },
  });
  const out = latestUsageAccountsFromLines([inRateLimits], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "work-123");
  assert.equal(out[0].label, "Work");
});

test("latestUsageAccountsFromLines falls back to payload.email when no id is set", () => {
  const withEmail = JSON.stringify({
    timestamp: "2026-06-03T11:00:00.000Z",
    payload: {
      type: "token_count",
      email: "ada@example.com",
      rate_limits: {
        primary: { used_percent: 1 },
        secondary: { used_percent: 2 },
      },
    },
  });
  const out = latestUsageAccountsFromLines([withEmail], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ada@example.com");
  // Label falls back to the id-shaped value when no label is logged.
  assert.equal(out[0].label, "ada@example.com");
});

test("latestUsageAccountsFromLines reads id/label from a nested payload.account", () => {
  const withAccountObj = JSON.stringify({
    timestamp: "2026-06-03T11:00:00.000Z",
    payload: {
      type: "token_count",
      account: { id: "team-42", label: "Team" },
      rate_limits: {
        primary: { used_percent: 6 },
        secondary: { used_percent: 14 },
      },
    },
  });
  const out = latestUsageAccountsFromLines([withAccountObj], 0);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "team-42");
  assert.equal(out[0].label, "Team");
});
