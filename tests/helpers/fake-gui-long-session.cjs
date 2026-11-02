#!/usr/bin/env node
const readline = require('node:readline');
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => write({ method, params });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method || message.id === undefined) return;
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    write({ id: message.id, result: { thread: { id: 'long-session' }, model: 'fake' } });
  } else if (message.method === 'turn/start') {
    write({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    event('turn/started', { turn: { id: 'turn' } });
    for (let i = 0; i < 40; i++) event('item/completed', { item: { id: 'action-' + i, type: 'commandExecution', command: 'Action ' + i, status: 'completed', aggregatedOutput: Array.from({ length: 100 }, (_, row) => `Output ${i}:${row}`).join('\n') } });
    for (let i = 0; i < 1000; i++) event('item/agentMessage/delta', { itemId: 'answer', delta: i === 999 ? 'last chunk' : 'x' });
    // No item/completed text: the GUI must retain the actual buffered deltas.
    event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  } else write({ id: message.id, result: message.method === 'model/list' || message.method === 'thread/list' ? { data: [] } : {} });
});
