import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatClaudeUsage } from '../dist-electron/claude-usage.js';

const usage = { session: { total_cost_usd: 0, model_usage: {} }, subscription_type: null, rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 75.25, resets_at: 'invalid' } } };

test('usage separates account-wide limits and session cost, retaining genuine zero utilization', () => {
  const text = formatClaudeUsage(usage);
  assert.match(text, /account-wide/);
  assert.match(text, /5-hour window: 0% used/);
  assert.match(text, /7-day window: 75\.3% used/);
  assert.match(text, /\$0\.0000 USD/);
  assert.match(text, /not a subscription charge/);
  assert.doesNotMatch(text, /Invalid Date/);
});

test('missing, null and API-key limits remain unavailable rather than showing 0%', () => {
  for (const limits of [null, {}, { five_hour: null }, { five_hour: { utilization: null, resets_at: null } }]) {
    const text = formatClaudeUsage({ ...usage, rate_limits: limits });
    assert.match(text, /[Uu]navailable/);
    assert.doesNotMatch(text, /0% used/);
  }
  const apiKey = formatClaudeUsage({ ...usage, rate_limits_available: false });
  assert.match(apiKey, /Plan limits unavailable/);
  assert.doesNotMatch(apiKey, /0% used/);
  assert.match(formatClaudeUsage({ ...usage, session: { total_cost_usd: 0 } }), /Model token usage unavailable/);
});

test('usage renders model buckets, reset times, cache tokens and safely escaped names', () => {
  const reset = '2026-11-18T18:00:00Z';
  const text = formatClaudeUsage({ ...usage, session: { total_cost_usd: 1.25, model_usage: {
    'model[1]': { inputTokens: 1200, outputTokens: 40, cacheReadInputTokens: 500, cacheCreationInputTokens: 0 },
  } }, rate_limits: { five_hour: { utilization: 20, resets_at: reset }, model_scoped: [{ display_name: 'New[model]', utilization: 110, resets_at: null }] } });
  assert.ok(text.includes(new Date(reset).toLocaleString()));
  assert.match(text, /110% used/);
  assert.ok(text.includes('New\\[model\\]'));
  assert.match(text, /1,200 input · 40 output · 500 cache read · 0 cache write tokens/);
});

test('unrecognized or corrupt usage responses fail explicitly', () => {
  for (const value of [null, {}, { ...usage, session: {} }, { ...usage, session: { total_cost_usd: NaN } }, { ...usage, session: { total_cost_usd: -1 } }]) {
    assert.throws(() => formatClaudeUsage(value), /unsupported usage response/);
  }
});
