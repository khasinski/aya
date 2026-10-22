import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAntigravityUsage, createAntigravityUsageReader } from '../dist-electron/usage-antigravity.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const end = '2026-10-23T12:00:00Z';
const bucket = (window, fraction) => ({ window, remaining_fraction: fraction, reset_time: end });
const payload = (buckets = [bucket('weekly', .2), bucket('5h', .9)]) => JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets }] } } });

test('converts remaining fractions to used percentages and preserves windows/resets', () => {
  const [group] = parseAntigravityUsage(payload(), NOW);
  assert.equal(group.label, 'Gemini Models');
  assert.equal(group.usage.sevenDay.pct, 80);
  assert.ok(Math.abs(group.usage.fiveHour.pct - 10) < .0001);
  assert.equal(group.usage.sevenDay.resetsAt, end);
  assert.equal(group.usage.updatedAt, new Date(NOW).toISOString());
  assert.equal(parseAntigravityUsage(payload([bucket('weekly', 0)]), NOW)[0].usage.sevenDay.pct, 100);
  assert.equal(parseAntigravityUsage(payload([bucket('5h', 1)]), NOW)[0].usage.fiveHour.pct, 0);
});

test('does not invent limits from unknown, expired, malformed or non-command responses', () => {
  for (const raw of ['null', '{}', 'not json', JSON.stringify({ status:'SUCCESS', response: '99%' }), payload([null, bucket('weekly', '0.5'), bucket('weekly', -1), bucket('weekly', 2), bucket('other', .5), { ...bucket('5h', .5), reset_time: 'yesterday' }, { ...bucket('5h', .5), reset_time: new Date(NOW).toISOString() }])]) {
    assert.deepEqual(parseAntigravityUsage(raw, NOW), []);
  }
});

test('coalesces calls, caches and retains the original timestamp on failed refresh', async () => {
  let now = NOW, calls = 0, fail = false;
  const read = createAntigravityUsageReader(async () => { calls++; if (fail) throw new Error('offline'); return payload(); }, () => now);
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  await read(); assert.equal(calls, 1);
  now += 60_000; fail = true;
  assert.deepEqual(await read(), first);
  assert.equal(calls, 2);
  now += 60_000; fail = false;
  assert.notEqual((await read())[0].usage.updatedAt, first[0].usage.updatedAt);
});

test('missing CLI returns no usage and backs off', async () => {
  let calls = 0;
  const read = createAntigravityUsageReader(async () => { calls++; throw new Error('ENOENT'); }, () => NOW);
  assert.deepEqual(await read(), []);
  assert.deepEqual(await read(), []);
  assert.equal(calls, 1);
});
