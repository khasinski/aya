#!/usr/bin/env node
const readline = require('node:readline');
let busy = false;
let sampleAttempts = 0;
let activeTurn = 'turn';
let lastArtifactId = '';
let goal = null;
let progressId = '';
let progressStep = 0;
let holdProgress = false;
let bulkIndex = -1;
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => write({ method, params });
const nextBulkWidget = () => write({ id: 'bulk-present', method: 'item/tool/call', params: { tool: 'aya_present', arguments: { kind: 'html', title: `Bulk widget ${bulkIndex}`, html: `<h2>Widget ${bulkIndex}</h2><!--${'x'.repeat(1792 * 1024)}-->` } } });
const complete = text => {
  event('item/started', { item: { id: 'answer', type: 'agentMessage', text: '' } });
  event('item/agentMessage/delta', { itemId: 'answer', delta: text });
  event('item/completed', { item: { id: 'answer', type: 'agentMessage', text } });
  event('turn/completed', { turn: { id: 'turn', status: 'completed' } }); busy = false;
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params || {};
  if (message.method === 'initialize') write({ id: message.id, result: { userAgent: 'test' } });
  else if ((message.method === 'thread/start' || message.method === 'thread/resume')) {
    event('fixture/config', p);
    write({ id: message.id, result: { thread: { id: p.threadId || (process.env.AYA_E2E_RUN === '1' ? 'thread-' + process.pid : 'test-thread') }, model: 'fake-codex' } });
  } else if (message.method === 'model/list') write({ id: message.id, result: { data: [{ id: 'fake-codex', model: 'fake-codex', displayName: 'Fake Codex', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }, { id: 'fake-pro', model: 'fake-pro', displayName: 'Fake Pro', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }] } });
  else if (message.method === 'turn/steer') { write({ id: message.id, result: { turnId: p.expectedTurnId } }); event('fixture/steer', p); }
  else if (message.method === 'thread/goal/set') {
    goal = { objective: p.objective || goal?.objective || 'Existing goal', status: p.status || 'active' };
    event('thread/goal/updated', { goal });
    event('thread/goal/updated', { goal: { ...goal, tokensUsed: 12 } });
    write({ id: message.id, result: { goal } });
    if (p.objective === 'Start an automatic turn') { busy = true; activeTurn = 'goal-turn'; event('turn/started', { turn: { id: activeTurn } }); }
  }
  else if (message.method === 'thread/goal/get') write({ id: message.id, result: { goal } });
  else if (message.method === 'thread/goal/clear') { goal = null; event('thread/goal/cleared', {}); write({ id: message.id, result: {} }); }
  else if (message.method === 'thread/list') write({ id: message.id, result: { data: [{ id: 'native-history', cwd: process.cwd(), name: 'Native CLI conversation', updatedAt: 1234567890 }, { id: 'wrong-project', cwd: '/other-project', name: 'Private other project' }] } });
  else if (message.method === 'thread/read') {
    event('fixture/history', { method: message.method, ...p });
    if (p.includeTurns) { write({ id: message.id, error: { code: -32602, message: 'Full history would exceed 16 MB; use pagination' } }); return; }
    write({ id: message.id, result: { thread: { id: p.threadId, cwd: p.threadId === 'wrong-project' ? '/other-project' : process.cwd(), turns: [] } } });
  }
  else if (message.method === 'thread/turns/list') {
    event('fixture/history', { method: message.method, ...p });
    if (p.itemsView === 'notLoaded') { write({ id: message.id, result: { data: [{ id: 'turn', items: [] }], nextCursor: null } }); return; }
    if (p.threadId === 'large-history') {
      const offset = Number(p.cursor || 0);
      const data = Array.from({ length: p.limit }, (_, i) => {
        const index = 599 - offset - i;
        return { id: `turn-${index}`, items: [{ id: `message-${index}`, type: 'agentMessage', text: `Answer ${index}` }, { id: `tool-${index}`, type: 'commandExecution' }] };
      });
      write({ id: message.id, result: { data, nextCursor: String(offset + p.limit) } }); return;
    }
    write({ id: message.id, result: { data: [{ id: p.cursor ? 'older' : 'newer', items: p.cursor
      ? [{ id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'A question from the CLI' }] }]
      : [{ id: 'native-agent', type: 'agentMessage', text: 'An answer from the CLI' }]
    }], nextCursor: p.cursor ? null : 'older' } });
  }
  else if (message.method === 'thread/sample') {
    event('fixture/sample', { attempt: ++sampleAttempts, ...p });
    if (p.prompt === 'idle-race' && sampleAttempts <= 2) write({ id: message.id, error: { code: -32600, message: 'sample source must be idle' } });
    else if (p.prompt === 'sample-error') write({ id: message.id, error: { code: -32600, message: 'Sample unavailable' } });
    else write({ id: message.id, result: { text: 'A separate side answer', sourceTurnId: p.expectedTurnId } });
  }
  else if (message.method === 'turn/start') {
    busy = true;
    activeTurn = 'turn';
    event('fixture/turn', p);
    const prompt = p.input[0].text;
    if (prompt === 'slow-start') { setTimeout(() => { write({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } }); event('turn/started', { turn: { id: 'turn' } }); }, 100); return; }
    if (prompt === 'handoff-before-ack') {
      event('turn/started', { turn: { id: 'turn' } });
      event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
      activeTurn = 'next-turn'; event('turn/started', { turn: { id: activeTurn } });
      event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
      setTimeout(() => write({ id: message.id, result: { turn: { id: 'turn', status: 'completed' } } }), 100); return;
    }
    if (prompt === 'delay-ack') { event('turn/started', { turn: { id: 'turn' } }); setTimeout(() => { write({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } }); complete('Delayed acknowledgement'); }, 700); return; }
    write({ id: message.id, result: { turn: { id: 'turn', status: 'inProgress' } } });
    event('turn/started', { turn: { id: 'turn' } });
    if (prompt === 'many-widgets') { bulkIndex = 0; nextBulkWidget(); return; }
    if (prompt === 'long-stream') {
      const itemId = 'stream-' + Date.now();
      let chunk = 0;
      const timer = setInterval(() => {
        event('item/agentMessage/delta', { itemId, delta: `Paragraph ${++chunk}: Streaming a response with enough text to exercise the conversation viewport.\n\n` });
        if (chunk === 80) { clearInterval(timer); event('turn/completed', { turn: { id: 'turn', status: 'completed' } }); busy = false; }
      }, 30);
      return;
    }
    if (prompt === 'reopen' || prompt === 'open-missing') write({ id: 'open-artifact', method: 'item/tool/call', params: { tool: 'aya_open_artifact', arguments: { artifactId: prompt === 'open-missing' ? 'missing' : lastArtifactId } } });
    else if (prompt === 'html-widget' || prompt === 'update-widget' || prompt === 'update-widget-closed') write({ id: 'present', method: 'item/tool/call', params: { tool: 'aya_present', arguments: { kind: 'html', title: 'Capacity planner', ...(prompt.startsWith('update-widget') ? { artifactId: lastArtifactId } : {}), open: prompt !== 'update-widget-closed', html: `<style>button{padding:12px 20px;background:#b9a6f7;border:0;border-radius:8px}h2{font-weight:500}</style><h2>${prompt === 'update-widget' ? 'Updated capacity' : 'Team capacity'}</h2><p>Choose a scenario to discuss with Codex.</p><button onclick="window.ayaWidget.suggest('Explore a four-person team')">Four-person team</button><p id="sandbox-check"></p><script>document.querySelector('#sandbox-check').textContent = typeof window.aya === 'undefined' ? 'Isolated preview' : 'Unsafe preview';</script>` } } });
    else if (prompt === 'graphic') write({ id: 'present', method: 'item/tool/call', params: { tool: 'aya_present', arguments: { kind: 'image', title: 'Aya mark', path: 'graphic.svg', open: true } } });
    else if ((prompt === 'progress' || prompt === 'progress-wait')) { progressStep = 0; holdProgress = prompt === 'progress-wait'; write({ id: 'progress', method: 'item/tool/call', params: { tool: 'aya_progress', arguments: { label: 'Decompiling functions', current: 0, total: 10, detail: 'Reading the function list' } } }); }
    else if (prompt === 'block-goal') { goal = { ...goal, status: 'blocked' }; event('thread/goal/updated', { goal }); complete('Deployment is blocked because the staging API key is missing. Add the key to continue.'); }
    else if (prompt === 'complete-goal') { goal = { ...goal, status: 'complete' }; event('thread/goal/updated', { goal }); event('thread/goal/updated', { goal: { ...goal, tokensUsed: 24 } }); complete('The goal is complete.'); }
    else if (prompt === 'completed-tools-wait' || prompt === 'mixed-tools-wait') {
      event('item/started', { item: { id: 'read', type: 'commandExecution', command: 'cat README.md' } });
      event('item/completed', { item: { id: 'read', type: 'commandExecution', command: 'cat README.md', status: 'completed' } });
      event('item/completed', { item: { id: 'check', type: 'commandExecution', command: 'check', status: prompt === 'mixed-tools-wait' ? 'failed' : 'completed' } });
      if (prompt === 'mixed-tools-wait') event('item/started', { item: { id: 'test', type: 'commandExecution', command: 'npm test' } });
    }
    else if (prompt === 'approval-options') write({ id: 'approve', method: 'item/commandExecution/requestApproval', params: { command: 'git status', proposedExecpolicyAmendment: ['git', 'status'], availableDecisions: ['accept', 'acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } }, 'decline'] } });
    else if (prompt === 'permissions') write({ id: 'approve', method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } });
    else if (prompt === 'disconnect-approval') {
      write({ id: 'approve', method: 'item/commandExecution/requestApproval', params: { command: 'echo hello', reason: 'Test approval' } });
      setTimeout(() => process.exit(0), 1000);
    }
    else if (prompt === 'approval') write({ id: 'approve', method: 'item/commandExecution/requestApproval', params: { command: 'echo hello', reason: 'Test approval' } });
    else if (prompt === 'wait') return;
    else if (prompt === 'question') write({ id: 'question', method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Which option?', options: [{ label: 'A', description: 'First' }] }] } });
    else if (prompt === 'async-question') {
      const qTitle = 'Allow non-zero instruction distance?';
      const opts = ['Readable C, allow non-zero distance', 'Keep distance 0'];
      const text = [qTitle, ...opts.map(o => `- ${o}`)].join('\n');
      event('item/started', { item: { id: 'call_async_1', type: 'agentMessage', text, delivery: 'async', questions: [{ title: qTitle, options: opts }] } });
      event('item/completed', { item: { id: 'call_async_1', type: 'agentMessage', text, delivery: 'async', questions: [{ title: qTitle, options: opts }] } });
      event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
      busy = false;
    }
    else if (prompt.startsWith('Keep distance 0') || prompt.startsWith('Readable C')) complete(`Answered: ${prompt}`);
    else write({ id: 'present', method: 'item/tool/call', params: { threadId: 'test-thread', turnId: 'turn', tool: 'aya_present', arguments: { open: prompt === 'open-widget', kind: 'table', title: prompt === 'open-widget' ? 'Opened by Codex' : 'A real tool result', columns: ['Name', 'State'], rows: [['Aya', 'Ready']] } } });
  } else if (message.method === 'turn/interrupt') {
    event('fixture/interrupt', p); write({ id: message.id, result: {} }); event('turn/completed', { turn: { id: activeTurn, status: 'interrupted' } }); busy = false;
  } else if (!message.method && message.id === 'progress') {
    const result = JSON.parse(message.result.contentItems[0].text); progressId = result.progressId;
    if (holdProgress && progressStep === 1) return;
    if (++progressStep <= 2) write({ id: 'progress', method: 'item/tool/call', params: { tool: 'aya_progress', arguments: { progressId, label: 'Decompiling functions', current: progressStep === 1 ? 4 : 10, total: 10, detail: progressStep === 1 ? 'Decompiled four functions' : 'All ten functions are ready' } } });
    else complete('All functions have been decompiled.');
  } else if (!message.method && message.id === 'approve') { event('fixture/approval', message.result); complete(typeof message.result.decision === 'string' ? message.result.decision : JSON.stringify(message.result)); }
  else if (!message.method && message.id === 'bulk-present') {
    if (!message.result.success) { complete('Widget creation failed'); return; }
    if (++bulkIndex < 20) nextBulkWidget();
    else complete('Twenty large widgets are saved.');
  }
  else if (!message.method && message.id === 'question') complete(message.result.answers.choice.answers[0]);
  else if (!message.method && message.id === 'open-artifact') complete(message.result.success ? 'Artifact opened' : 'Unknown artifact');
  else if (!message.method && message.id === 'present') { lastArtifactId = message.result.contentItems[0].text.match(/artifactId: ([^.]+)\./)?.[1] || ''; complete(message.result.success ? '## Wynik\n\nTabela jest w panelu artefaktów.\n\n| Element | Stan |\n| --- | --- |\n| Aya | Gotowe |' : 'Tool failed'); }
  else if (message.method && message.id) write({ id: message.id, error: { code: -32601, message: 'Unsupported fixture request' } });
});
process.on('SIGTERM', () => process.exit(busy ? 2 : 0));
