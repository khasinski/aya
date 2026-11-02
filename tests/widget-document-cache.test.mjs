import test from 'node:test';
import assert from 'node:assert/strict';
import { WidgetDocumentCache } from '../dist-electron/widget-document-cache.js';
test('the global preview budget bounds many panels, retaining recently accessed documents', () => {
  const cache = new WidgetDocumentCache(12, 24);
  cache.set('a', 'panel-a', 'a'.repeat(10)); cache.set('b', 'panel-b', 'b'.repeat(10));
  cache.get('a'); cache.set('c', 'panel-c', 'c'.repeat(10));
  assert.equal(cache.get('b'), undefined); assert.ok(cache.get('a')); assert.ok(cache.get('c'));
  assert.deepEqual(cache.stats(), { bytes: 20, documents: 2, owners: 2 });
});
test('per-panel eviction, multibyte accounting and owner teardown keep budgets exact', () => {
  const cache = new WidgetDocumentCache(12, 24);
  cache.set('a', 'panel-a', 'ą'.repeat(4)); cache.set('b', 'panel-a', 'b'.repeat(8));
  assert.equal(cache.get('a'), undefined); assert.equal(cache.stats().bytes, 8);
  cache.set('c', 'panel-b', 'c'); cache.clearOwner('panel-a');
  assert.deepEqual(cache.stats(), { bytes: 1, documents: 1, owners: 1 });
  cache.clearOwner('panel-b'); assert.deepEqual(cache.stats(), { bytes: 0, documents: 0, owners: 0 });
});
test('replacement does not double-count and oversized input preserves the previous document', () => {
  const cache = new WidgetDocumentCache(10, 20);
  cache.set('a', 'owner', 'small'); cache.set('a', 'owner', 'new');
  assert.deepEqual(cache.stats(), { bytes: 3, documents: 1, owners: 1 });
  assert.throws(() => cache.set('a', 'owner', 'x'.repeat(11)), /budget/);
  assert.equal(cache.get('a').html, 'new');
});
