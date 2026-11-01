import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const isolatedHome = await mkdtemp(path.join(tmpdir(), 'aya-gui-unit-'));
process.env.AYA_HOME = isolatedHome;
after(() => rm(isolatedHome, { recursive: true, force: true }));
const { CodexGuiSession, PiGuiSession, ClaudeGuiSession, AntigravityGuiSession, workspaceImage, presentArtifact } = await import('../dist-electron/codex-gui-session.js');
import { progressUpdate } from '../dist-electron/gui-progress.js';
const fixture = path.resolve('tests/helpers/fake-codex-gui.cjs');
const piFixture = path.resolve('tests/helpers/fake-pi-gui.cjs');
const claudeFixture = path.resolve('tests/helpers/fake-claude-gui.cjs');
const agyFixture = path.resolve('tests/helpers/fake-agy-gui.cjs');
const wait = async predicate => { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('Codex keeps ownership of policies and tool calls produce Aya artifacts', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close());
  const result = await session.connect(process.cwd(), '');
  assert.equal(result.threadId, 'test-thread');
  const config = events.find(e => e.method === 'fixture/config').params;
  assert.equal(config.approvalPolicy, 'on-request');
  assert.equal(config.sandbox, 'workspace-write');
  assert.equal(config.dynamicTools[0].name, 'aya_present');
  await session.send('widgets');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  const artifact = events.find(e => e.method === 'aya/artifact').params.artifact;
  assert.deepEqual(artifact.rows, [['Aya', 'Ready']]);
  assert.equal(events.find(e => e.method === 'item/completed').params.item.type, 'agentMessage');
});
test('approval requests wait for an explicit decision; stale responses cannot approve a later request', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), ''); await session.send('approval');
  await wait(() => events.some(e => e.id === 'approve'));
  await assert.rejects(session.send('another turn'), /working/);
  assert.equal(events.some(e => e.method === 'turn/completed'), false);
  await session.respond('approve', { decision: 'decline' });
  await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(events.find(e => e.method === 'item/completed').params.item.text, 'decline');
  await assert.rejects(session.respond('approve', { decision: 'accept' }), /already ended/);
});
test('questions round-trip user answers and turns can be interrupted', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), ''); await session.send('question');
  await wait(() => events.some(e => e.id === 'question'));
  await session.respond('question', { answers: { choice: 'A' } });
  await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(events.find(e => e.method === 'item/completed').params.item.text, 'A');
  await session.send('wait'); await session.interrupt();
  await wait(() => events.some(e => e.method === 'turn/completed' && e.params.turn.status === 'interrupted'));
});
test('artifacts reject malformed shapes and images cannot leave the workspace or load HTML', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aya-gui-image-'));
  try {
    const project = path.join(root, 'project'); await import('node:fs/promises').then(fs => fs.mkdir(project));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRc8AAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(project, 'image.png'), png); await writeFile(path.join(root, 'outside.png'), png);
    await symlink(path.join(root, 'outside.png'), path.join(project, 'escape.png'));
    await writeFile(path.join(project, 'page.png'), '<html>not an image</html>');
    assert.match(await workspaceImage(project, 'image.png'), /^data:image\/png;base64,/);
    await assert.rejects(workspaceImage(project, '../outside.png'), /inside/);
    await assert.rejects(workspaceImage(project, 'escape.png'), /inside/);
    await assert.rejects(workspaceImage(project, 'page.png'), /Supported images/);
    await assert.rejects(presentArtifact(project, { kind: 'table', title: 'bad', columns: ['A'], rows: [['too', 'many']] }), /Invalid artifact/);
    assert.equal((await presentArtifact(project, { kind: 'html', title: 'Widget', html: '<button>Hello</button>' })).kind, 'html');
    await assert.rejects(presentArtifact(project, { kind: 'html', title: 'Empty', html: '' }), /HTML widgets require/);
    await writeFile(path.join(project, 'graphic.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
    assert.match(await workspaceImage(project, 'graphic.svg'), /^data:image\/svg\+xml;base64,/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native goals and side questions use dedicated RPCs, never ordinary turns', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  assert.equal((await session.command('goal', 'Ship the feature')).goal.objective, 'Ship the feature');
  assert.equal((await session.command('goal', 'pause')).goal.status, 'paused');
  assert.equal((await session.command('btw', 'Explain the context')).text, 'A separate side answer');
  assert.equal(events.some(e => e.method === 'turn/started'), false);
  await assert.rejects(session.command('unknown', ''), /Unsupported command/);
});

test('the model can open new or existing artifacts, but cannot select an unknown ID', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('open-widget');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  const created = events.find(e => e.method === 'aya/artifact');
  assert.equal(created.params.open, true);
  events.length = 0;
  await session.send('reopen'); await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(events.find(e => e.method === 'aya/openArtifact').params.artifactId, created.params.artifact.id);
  assert.equal(events.some(e => e.method === 'aya/artifact'), false);
  events.length = 0;
  await session.send('open-missing'); await wait(() => events.some(e => e.method === 'turn/completed'));
  assert.equal(events.some(e => e.method === 'aya/openArtifact'), false);
  assert.equal(events.find(e => e.method === 'item/completed').params.item.text, 'Unknown artifact');
});

test('models, turn options and steering use the native Codex protocol', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  assert.equal((await session.models()).data[1].model, 'fake-pro');
  await session.send('wait', { model: 'fake-pro', effort: 'high', images: ['/project/screenshot.png'] });
  const turn = events.find(e => e.method === 'fixture/turn').params;
  assert.equal(turn.model, 'fake-pro'); assert.equal(turn.effort, 'high');
  assert.deepEqual(turn.input[1], { type: 'localImage', path: '/project/screenshot.png' });
  await session.steer('Focus on UX');
  await wait(() => events.some(e => e.method === 'fixture/steer'));
  assert.equal(events.find(e => e.method === 'fixture/steer').params.expectedTurnId, 'turn');
  await session.interrupt(); await wait(() => events.some(e => e.method === 'turn/completed'));
  await assert.rejects(session.steer('Too late'), /no active turn/);
});

test('measured progress updates the same task and completes at the actual total', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  const config = events.find(e => e.method === 'fixture/config').params;
  assert.ok(config.dynamicTools.some(tool => tool.name === 'aya_progress'));
  await session.send('progress'); await wait(() => events.some(e => e.method === 'turn/completed'));
  const progress = events.filter(e => e.method === 'aya/progress').map(e => e.params.progress);
  assert.deepEqual(progress.map(p => p.current), [0, 4, 10]);
  assert.equal(new Set(progress.map(p => p.id)).size, 1);
  assert.equal(progress[2].status, 'complete');
});

test('progress rejects impossible counts, false completion and unknown update IDs', () => {
  assert.throws(() => progressUpdate({ label: 'Task', current: 11, total: 10 }), /current/);
  assert.throws(() => progressUpdate({ label: 'Task', current: 0, total: 0 }), /positive total/);
  assert.throws(() => progressUpdate({ label: 'Task', current: NaN, total: 10 }), /finite/);
  assert.throws(() => progressUpdate({ label: 'Task', current: 4, total: 10, status: 'complete' }), /equal to total/);
  assert.throws(() => progressUpdate({ label: 'Task', current: 4, total: 10, progressId: 'unknown' }), /Unknown progressId/);
});

test('interrupting measured work pauses progress without inventing completion', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [fixture]);
  t.after(() => session.close()); await session.connect(process.cwd(), '');
  await session.send('progress-wait'); await wait(() => events.some(e => e.method === 'aya/progress' && e.params.progress.current === 4));
  await session.interrupt(); await wait(() => events.some(e => e.method === 'turn/completed'));
  const last = events.filter(e => e.method === 'aya/progress').at(-1).params.progress;
  assert.equal(last.status, 'paused'); assert.equal(last.current, 4); assert.equal(last.total, 10);
});

for (const spec of [
  {
    name: 'Pi',
    SessionClass: PiGuiSession,
    fixturePath: piFixture,
    expectedThread: 'pi-test-thread',
    expectedModel: 'fake-pi',
    nextModel: 'fake-pi-pro',
    expectedSideAnswer: 'A separate side answer from Pi',
    openedTitle: 'Opened by Pi',
  },
  {
    name: 'Claude',
    SessionClass: ClaudeGuiSession,
    fixturePath: claudeFixture,
    expectedThread: 'claude-test-thread',
    expectedModel: 'fake-claude',
    nextModel: 'fake-claude-opus',
    expectedSideAnswer: 'A separate side answer from Claude',
    openedTitle: 'Opened by Claude',
  },
  {
    name: 'Antigravity',
    SessionClass: AntigravityGuiSession,
    fixturePath: agyFixture,
    expectedThread: 'agy-test-thread',
    expectedModel: 'fake-agy',
    nextModel: 'fake-agy-pro',
    expectedSideAnswer: 'A separate side answer from Antigravity',
    openedTitle: 'Opened by Antigravity',
  },
]) {
  test(`${spec.name} GUI session supports artifacts, progress, approvals, questions, steering, goals and side questions`, async t => {
    const events = [];
    const session = new spec.SessionClass(e => events.push(e), process.execPath, [spec.fixturePath]);
    t.after(() => session.close());
    const result = await session.connect(process.cwd(), '');
    assert.equal(result.threadId, spec.expectedThread);
    assert.equal(result.model, spec.expectedModel);

    const models = await session.models();
    assert.equal(models.data[1].model, spec.nextModel);

    // 1. Artifact creation & reopening
    await session.send('open-widget');
    await wait(() => events.some(e => e.method === 'turn/completed'));
    const created = events.find(e => e.method === 'aya/artifact');
    assert.ok(created, `${spec.name} should emit aya/artifact`);
    assert.equal(created.params.open, true);
    assert.equal(created.params.artifact.title, spec.openedTitle);

    events.length = 0;
    await session.send('reopen');
    await wait(() => events.some(e => e.method === 'turn/completed'));
    assert.equal(events.find(e => e.method === 'aya/openArtifact').params.artifactId, created.params.artifact.id);

    // 2. Progress updates
    events.length = 0;
    await session.send('progress');
    await wait(() => events.some(e => e.method === 'turn/completed'));
    const progresses = events.filter(e => e.method === 'aya/progress').map(e => e.params.progress);
    assert.deepEqual(progresses.map(p => p.current), [0, 4, 10]);
    assert.equal(progresses[2].status, 'complete');

    // 3. Approval requests
    events.length = 0;
    await session.send('approval');
    await wait(() => events.some(e => e.method === 'item/commandExecution/requestApproval'));
    const approvalEvt = events.find(e => e.method === 'item/commandExecution/requestApproval');
    await session.respond(approvalEvt.id, { decision: 'decline' });
    await wait(() => events.some(e => e.method === 'turn/completed'));
    assert.equal(events.find(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage').params.item.text, 'decline');

    // 4. Clarifying questions
    events.length = 0;
    await session.send('question');
    await wait(() => events.some(e => e.method === 'item/tool/requestUserInput'));
    const questionEvt = events.find(e => e.method === 'item/tool/requestUserInput');
    await session.respond(questionEvt.id, { answers: { choice: 'A' } });
    await wait(() => events.some(e => e.method === 'turn/completed'));
    assert.equal(events.find(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage').params.item.text, 'A');

    // 5. Steering & Interruption
    events.length = 0;
    await session.send('wait', { model: spec.nextModel, effort: 'high' });
    await session.steer('Focus on UX');
    await wait(() => events.some(e => e.method === 'fixture/steer'));
    await session.interrupt();
    await wait(() => events.some(e => e.method === 'turn/completed' && e.params.turn.status === 'interrupted'));

    // 6. Goals & Side questions
    events.length = 0;
    assert.equal((await session.command('goal', 'Ship the feature')).goal.objective, 'Ship the feature');
    assert.equal((await session.command('goal', 'pause')).goal.status, 'paused');
    assert.equal((await session.command('goal', 'resume')).goal.status, 'active');
    assert.equal((await session.command('btw', 'Explain the context')).text, spec.expectedSideAnswer);
    await session.send('complete-goal');
    await wait(() => events.some(e => e.method === 'turn/completed'));
    assert.equal(events.filter(e => e.method === 'thread/goal/updated').at(-1).params.goal.status, 'complete');
  });
}


test('Codex native history filters other workspaces and reconstructs user/assistant turns', async t => {
  const session = new CodexGuiSession(() => {}, process.execPath, [fixture]);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  const rows = await session.listConversations();
  assert.deepEqual(rows.map(row => row.id), ['codex:native-history']);
  const saved = await session.readConversation('native-history');
  assert.deepEqual(saved.view.messages.map(m => [m.type, m.text]), [['user', 'A question from the CLI'], ['assistant', 'An answer from the CLI']]);
  await assert.rejects(session.readConversation('wrong-project'), /workspace/);
});

test('late Antigravity initialization corrects the displayed model and resumable conversation ID', async t => {
  const events = [], session = new AntigravityGuiSession(event => events.push(event), process.execPath, [agyFixture, '--slow-init']);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  await wait(() => events.some(event => event.method === 'aya/session'));
  assert.deepEqual(events.find(event => event.method === 'aya/session').params, { threadId: 'agy-test-thread', model: 'fake-agy' });
});
