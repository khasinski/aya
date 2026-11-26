// Stopping subagents and streaming what they print, in Claude and Codex GUI sessions.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const isolatedHome = await mkdtemp(path.join(tmpdir(), 'aya-gui-subagents-'));
process.env.AYA_HOME = isolatedHome;
// The fake Claude writes its task output files here, as Claude Code does under CLAUDE_CODE_TMPDIR.
process.env.CLAUDE_CODE_TMPDIR = path.join(await realpath(isolatedHome), 'claude-tmp');
after(() => rm(isolatedHome, { recursive: true, force: true }));
const { ClaudeGuiSession, CodexGuiSession } = await import('../dist-electron/codex-gui-session.js');
const { TaskOutputTail, claudeTaskOutputRoot, locateClaudeTaskOutput, TASK_OUTPUT_MAX_READ_BYTES } = await import('../dist-electron/gui-task-output-tail.js');
const { canStopSubagent, showStop, startsSubagent } = await import('../dist-test/gui-subagents.js');
const claudeFixture = path.resolve('tests/helpers/fake-claude-gui.cjs');
const codexFixture = path.resolve('tests/helpers/fake-codex-gui.cjs');
const wait = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('Claude task output lives under its own temp root, honouring CLAUDE_CODE_TMPDIR', () => {
  assert.equal(claudeTaskOutputRoot({ TMPDIR: '/var/folders/x' }, '/work', 'darwin', 501), '/tmp/claude-501');
  assert.equal(claudeTaskOutputRoot({ TMPDIR: '/var/tmp' }, '/work', 'linux', 1000), '/var/tmp/claude-1000');
  assert.equal(claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: 'scratch' }, '/work', 'darwin', 501), '/work/scratch/claude-501');
  assert.equal(claudeTaskOutputRoot({}, '/work', 'win32', null), undefined);
});

test('a task output file is found by the working directory slug or in any project directory', async () => {
  const root = path.join(isolatedHome, 'locate');
  const slugged = path.join(root, '-work-my-app', 's1', 'tasks');
  await mkdir(slugged, { recursive: true }); await writeFile(path.join(slugged, 't1.output'), '');
  assert.equal(await locateClaudeTaskOutput(root, '/work/my.app', 's1', 't1'), path.join(slugged, 't1.output'));
  const other = path.join(root, 'renamed-project', 's1', 'tasks');
  await mkdir(other, { recursive: true }); await writeFile(path.join(other, 't2.output'), '');
  assert.equal(await locateClaudeTaskOutput(root, '/work/my.app', 's1', 't2'), path.join(other, 't2.output'));
  assert.equal(await locateClaudeTaskOutput(root, '/work/my.app', 's1', 'missing'), null);
  assert.equal(await locateClaudeTaskOutput(path.join(root, 'none'), '/work', 's1', 't1'), null);
});

test('a task output tail streams appended text, skips ahead of a fast writer and reads once more when stopped', async () => {
  const dir = path.join(isolatedHome, 'tail'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'task.output'); await writeFile(file, 'one\n');
  const chunks = [];
  const tail = new TaskOutputTail({ file, cwd: dir, sessionId: 's', taskId: 't', pollMs: 20, onChunk: chunk => chunks.push(chunk) });
  await wait(() => chunks.join('') === 'one\n');
  await appendFile(file, 'two\n');
  await wait(() => chunks.join('') === 'one\ntwo\n');
  // More than the read limit at once: only the tail arrives, on a line of its own, never inside a character.
  await appendFile(file, 'é'.repeat(TASK_OUTPUT_MAX_READ_BYTES) + 'end\n');
  await wait(() => chunks.join('').endsWith('end\n'));
  const skipped = chunks.at(-1);
  assert.ok(skipped.startsWith('\n'));
  assert.ok(!skipped.includes('�'));
  assert.ok(Buffer.byteLength(skipped) <= TASK_OUTPUT_MAX_READ_BYTES + 1);
  await appendFile(file, 'last\n');
  await tail.stop();
  assert.ok(chunks.join('').endsWith('end\nlast\n'));
  assert.equal(tail.active, false);
  const count = chunks.length;
  await appendFile(file, 'after\n'); await sleep(80);
  assert.equal(chunks.length, count);
});

test('a task output tail looks for its file under the temp root and gives up when disposed', async () => {
  const root = path.join(isolatedHome, 'tail-root'), cwd = '/work/app';
  const chunks = [];
  const tail = new TaskOutputTail({ root, cwd, sessionId: 's', taskId: 'late', pollMs: 20, onChunk: chunk => chunks.push(chunk) });
  await sleep(60);
  const dir = path.join(root, '-work-app', 's', 'tasks'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'late.output'), 'found\n');
  await wait(() => chunks.join('') === 'found\n');
  tail.dispose();
  await appendFile(path.join(dir, 'late.output'), 'ignored\n'); await sleep(80);
  assert.equal(chunks.join(''), 'found\n');
});

const agentItems = events => events.filter(e => e.params?.item?.type === 'collabAgentToolCall');
const outputOf = (events, id) => events.filter(e => e.method === 'item/commandExecution/outputDelta' && e.params.itemId === id).map(e => e.params.delta).join('');

test('Claude GUI streams what a subagent command prints and stops that subagent alone', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('stoppable-agent');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  // The command's output arrives while it runs, after the subagent's tool line.
  await wait(() => /tick 3\n/.test(outputOf(events, 'toolu_agent2')));
  assert.match(outputOf(events, 'toolu_agent2'), /^Bash: Print ticks\ntick 1\ntick 2\ntick 3\n/);
  assert.equal(agentItems(events).some(e => e.method === 'item/completed'), false);
  await session.stopSubagent('toolu_agent2');
  assert.deepEqual(events.filter(e => e.method === 'fixture/stop-task').map(e => e.params.taskId), ['agent-2']);
  const done = agentItems(events).filter(e => e.method === 'item/completed');
  assert.equal(done.length, 1);
  assert.equal(done[0].params.item.status, 'interrupted');
  assert.equal(done[0].params.item.background, true);
  // Nothing more streams once it stopped; Claude reports the stop in a turn of its own.
  const streamed = outputOf(events, 'toolu_agent2');
  await wait(() => events.filter(e => e.method === 'turn/completed').length === 2);
  await sleep(400);
  assert.equal(outputOf(events, 'toolu_agent2'), streamed);
  assert.equal(events.filter(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage').at(-1).params.item.text, 'The subagent was stopped.');
  await session.stopSubagent('toolu_agent2');
  assert.equal(events.filter(e => e.method === 'fixture/stop-task').length, 1);
});

test('Claude GUI Stop also stops a background subagent that outlived its turn', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('stoppable-agent');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(session.running, false);
  await session.interrupt();
  const done = agentItems(events).filter(e => e.method === 'item/completed');
  assert.deepEqual(done.map(e => e.params.item.status), ['interrupted']);
  // Claude's interrupt already stopped it: no stop_task, and no new turn.
  assert.equal(events.some(e => e.method === 'fixture/stop-task'), false);
  await sleep(200);
  assert.equal(events.filter(e => e.method === 'turn/started').length, 1);
});

test('Claude GUI Stop sends a stop for each subagent an older Claude leaves running', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture, '--interrupt-spares-agents']);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('stoppable-agent-busy');
  await wait(() => /tick 1/.test(outputOf(events, 'toolu_agent2')));
  assert.equal(session.running, true);
  await session.interrupt();
  assert.deepEqual(events.filter(e => e.method === 'fixture/stop-task').map(e => e.params.taskId), ['agent-2']);
  assert.deepEqual(agentItems(events).filter(e => e.method === 'item/completed').map(e => e.params.item.status), ['interrupted']);
  await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(events.find(e => e.method === 'turn/completed').params.turn.status, 'interrupted');
});

test('Claude GUI ignores a stop for a subagent it does not know', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.stopSubagent('unknown');
  assert.equal(events.some(e => e.method === 'fixture/stop-task'), false);
});

const codexSpawns = events => events.filter(e => e.params?.item?.id === 'spawn-run');

test('Codex GUI keeps a spawned subagent running while its thread works, and stops it alone', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('subagent-runs');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  // The spawn call completed, but its agent still works: the row stays running, in the background.
  const last = codexSpawns(events).at(-1);
  assert.equal(last.method, 'item/started');
  assert.equal(last.params.item.status, 'inProgress');
  assert.equal(last.params.item.background, true);
  await session.stopSubagent('spawn-run');
  assert.deepEqual(events.filter(e => e.method === 'fixture/interrupt').map(e => e.params), [{ threadId: 'child-run-thread', turnId: 'child-run-turn' }]);
  await wait(() => codexSpawns(events).at(-1).method === 'item/completed');
  assert.equal(codexSpawns(events).at(-1).params.item.status, 'interrupted');
  await assert.rejects(session.stopSubagent('spawn-run'), /not running/);
});

test('Codex GUI Stop interrupts the turn and every subagent thread still running', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('subagent-runs-busy');
  await wait(() => codexSpawns(events).length === 3);
  await session.interrupt();
  const interrupts = events.filter(e => e.method === 'fixture/interrupt').map(e => e.params.threadId).sort();
  assert.deepEqual(interrupts, ['child-run-thread', 'test-thread']);
  await wait(() => codexSpawns(events).at(-1).method === 'item/completed');
  assert.equal(codexSpawns(events).at(-1).params.item.status, 'interrupted');
});

test('Codex GUI shows a subagent reported as subAgentActivity (Codex 0.172) as a spawn row that stops alone', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('subagent-activity');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(events.some(e => e.params?.item?.type === 'subAgentActivity'), false);
  const spawns = events.filter(e => e.params?.item?.id === 'call_spawn');
  const last = spawns.at(-1).params.item;
  assert.equal(spawns.at(-1).method, 'item/started');
  assert.deepEqual({ type: last.type, tool: last.tool, status: last.status, background: last.background, receiverThreadIds: last.receiverThreadIds, prompt: last.prompt },
    { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress', background: true, receiverThreadIds: ['child-run-thread'], prompt: 'watch build' });
  await session.stopSubagent('call_spawn');
  assert.deepEqual(events.filter(e => e.method === 'fixture/interrupt').map(e => e.params), [{ threadId: 'child-run-thread', turnId: 'child-run-turn' }]);
  await wait(() => events.filter(e => e.params?.item?.id === 'call_spawn').at(-1).method === 'item/completed');
  assert.equal(events.filter(e => e.params?.item?.id === 'call_spawn').at(-1).params.item.status, 'interrupted');
});

test('only a running call that started a subagent gets a Stop button', () => {
  assert.equal(startsSubagent({ type: 'collabAgentToolCall', tool: 'spawnAgent' }), true);
  assert.equal(startsSubagent({ type: 'collabAgentToolCall' }), true);
  assert.equal(startsSubagent({ type: 'collabAgentToolCall', tool: 'wait' }), false);
  assert.equal(startsSubagent({ type: 'commandExecution' }), false);
  assert.equal(canStopSubagent({ stoppable: true, status: 'inProgress' }), true);
  assert.equal(canStopSubagent({ stoppable: true, status: 'interrupted' }), false);
  assert.equal(canStopSubagent({ status: 'inProgress' }), false);
  assert.equal(showStop(true, 0), true);
  assert.equal(showStop(false, 2), true);
  assert.equal(showStop(false, 0), false);
});
