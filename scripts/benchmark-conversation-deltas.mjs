// Build test sources first: npm run build:test-src
// Measures reducer work only, not browser rendering or whole-app performance.
import { performance } from 'node:perf_hooks';
import { appendMessageDeltas } from '../dist-test/conversation-deltas.js';
const historySize = 10_000, chunks = 4096, chunksPerFrame = 16;
const initial = Array.from({ length: historySize }, (_, i) => ({ id: String(i), text: 'Earlier message' }));
const id = String(historySize - 1);
function run(batched) {
  let history = initial;
  const start = performance.now();
  for (let i = 0; i < chunks; i += batched ? chunksPerFrame : 1) {
    if (batched) history = appendMessageDeltas(history, [{ id, text: 'x'.repeat(chunksPerFrame) }], value => value);
    else history = history.some(message => message.id === id) ? history.map(message => message.id === id ? { ...message, text: message.text + 'x' } : message) : [...history, { id, text: 'x' }];
  }
  const milliseconds = performance.now() - start;
  if (history.at(-1).text !== initial.at(-1).text + 'x'.repeat(chunks)) throw Error('Benchmark lost text');
  return Number(milliseconds.toFixed(2));
}
run(false); run(true);
console.log(JSON.stringify({ historySize, chunks, chunksPerFrame, historyTraversals: { before: chunks * 2, after: chunks / chunksPerFrame }, samplesMs: Array.from({ length: 3 }, () => ({ before: run(false), after: run(true) })) }, null, 2));
