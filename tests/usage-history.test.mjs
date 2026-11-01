import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UsageLogParser, scanUsageHistory } from '../dist-electron/usage-history.js';
const timestamp = new Date().toISOString();
const codex = (input, cached, output, at = timestamp) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 3 } } } });
test('Codex counts cumulative deltas and cache exactly once, including repeated limit snapshots', () => {
  const parser = new UsageLogParser('codex');
  parser.line(JSON.stringify({ type: 'turn_context', payload: { model: 'test-model' } }));
  parser.line(codex(100, 40, 20)); parser.line(codex(100, 40, 20)); parser.line(codex(160, 60, 35, new Date(Date.now() + 1).toISOString()));
  const events = [...parser.events.values()];
  assert.equal(events.length, 2);
  assert.deepEqual(events.reduce((sum, e) => [sum[0] + e.input, sum[1] + e.cacheRead, sum[2] + e.output], [0, 0, 0]), [100, 60, 35]);
  assert.ok(events.every(e => e.model === 'test-model'));
});
test('Claude streamed assistant records merge by message ID instead of double counting', () => {
  const parser = new UsageLogParser('claude');
  const record = output => JSON.stringify({ timestamp, type: 'assistant', message: { id: 'same-message', model: 'claude-test', usage: { input_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: output } } });
  parser.line(record(2)); parser.line(record(12)); parser.line('{malformed');
  const [event] = [...parser.events.values()];
  assert.equal(parser.events.size, 1); assert.equal(event.input, 50); assert.equal(event.output, 12); assert.equal(event.cacheRead, 100); assert.equal(event.cacheWrite, 20);
});
test('history deduplicates copied fork events and account aliases without returning transcript text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aya-token-history-'));
  try {
    await mkdir(path.join(root, 'sessions'));
    const lines = JSON.stringify({ type: 'turn_context', payload: { model: 'test-model', cwd: 'PRIVATE_PROJECT' } }) + '\n' + codex(100, 40, 20) + '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'PRIVATE_PROMPT' } });
    await writeFile(path.join(root, 'sessions', 'one.jsonl'), lines); await writeFile(path.join(root, 'sessions', 'fork.jsonl'), lines);
    const alias = root + '-alias'; await symlink(root, alias); try {
      const result = await scanUsageHistory([{ provider: 'codex', home: root, label: 'Personal' }, { provider: 'codex', home: alias, label: 'Alias' }], 7);
      assert.equal(result.rows.length, 1); assert.equal(result.rows[0].input, 60); assert.equal(result.rows[0].cacheRead, 40); assert.equal(result.rows[0].output, 20);
      assert.equal(result.partial, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
      // An unchanged file uses its parsed cache; modifying it invalidates that cache.
      await writeFile(path.join(root, 'sessions', 'one.jsonl'), lines + '\n' + codex(150, 50, 30, new Date(Date.now() - 1).toISOString()));
      const updated = await scanUsageHistory([{ provider: 'codex', home: root, label: 'Personal' }], 7);
      assert.equal(updated.rows.reduce((sum, r) => sum + r.input + r.cacheRead + r.output, 0), 180);
    } finally { await rm(alias); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('counter resets use the reported last turn, and reasoning is never added to output again', () => {
  const parser = new UsageLogParser('codex');
  parser.line(codex(100, 40, 20));
  parser.line(JSON.stringify({ timestamp: new Date(Date.now() + 1).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 }, last_token_usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 8, reasoning_output_tokens: 5 } } } }));
  const last = [...parser.events.values()].at(-1);
  assert.equal(last.input, 20); assert.equal(last.cacheRead, 10); assert.equal(last.output, 8); assert.equal(last.reasoning, 5);
});
test('Grok counts cached input within the provider total rather than adding it twice', () => {
  const parser = new UsageLogParser('grok');
  parser.line(JSON.stringify({ timestamp: Date.now(), method: 'session/update', params: { update: { usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedReadTokens: 20, cacheCreationTokens: 10, reasoningTokens: 5, modelUsage: { 'grok-test': {} } } } } }));
  const [row] = [...parser.events.values()];
  assert.equal(row.input + row.output + row.cacheRead + row.cacheWrite, 150);
});

test('archived Codex sessions remain in token history even without an active sessions directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aya-archived-usage-'));
  try {
    await mkdir(path.join(root, 'archived_sessions'));
    await writeFile(path.join(root, 'archived_sessions', 'rollout.jsonl'), codex(100, 40, 20));
    const result = await scanUsageHistory([{ provider: 'codex', home: root, label: 'Archived' }], 7);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].input + result.rows[0].cacheRead + result.rows[0].output, 120);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('cached partial files keep their missing-accounting warning on subsequent scans', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'aya-partial-cache-'));
  try {
    await mkdir(path.join(home, 'projects'));
    await writeFile(path.join(home, 'projects', 'large.jsonl'), JSON.stringify({ type: 'assistant', timestamp, message: { id: 'large', model: 'test', content: 'x'.repeat(1100000), usage: { input_tokens: 100, output_tokens: 10 } } }));
    const sources = [{ provider: 'claude', home, label: 'Partial' }];
    const first = await scanUsageHistory(sources, 7);
    const cached = await scanUsageHistory(sources, 7);
    assert.equal(first.partial, true); assert.equal(cached.partial, true);
    assert.deepEqual(cached.rows, first.rows);
  } finally { await rm(home, { recursive: true, force: true }); }
});
