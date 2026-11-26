// Conversation GUI: declining an approval with a note, and the pane's permission mode.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approvalNoteDelivery, claudeDeclineMessage, claudePermissionMode, codexPermissionPolicy, fromClaudePermissionMode,
  guiPermissionModes, initialGuiPermissionMode, nextGuiPermissionMode, parseGuiPermissionMode,
} from '../shared/gui-permission-mode.cjs';
import { approvalNoteTarget, approvalSummary, declinableApproval, isPermissionModeShortcut, permissionModeChangeText } from '../dist-test/gui-approval-modes.js';
const isolatedHome = await mkdtemp(path.join(tmpdir(), 'aya-gui-modes-'));
process.env.AYA_HOME = isolatedHome;
after(() => rm(isolatedHome, { recursive: true, force: true }));
const { CodexGuiSession, ClaudeGuiSession } = await import('../dist-electron/codex-gui-session.js');
const codexFixture = path.resolve('tests/helpers/fake-codex-gui.cjs');
const claudeFixture = path.resolve('tests/helpers/fake-claude-gui.cjs');
const wait = async predicate => { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('only Claude and Codex offer modes, in T3 Code order, and the shortcut cycles them', () => {
  assert.deepEqual(guiPermissionModes('claude').map(m => m.label), ['Supervised', 'Auto-accept edits', 'Auto', 'Full access']);
  assert.equal(guiPermissionModes('codex').length, 4);
  assert.deepEqual(guiPermissionModes('pi'), []);
  assert.deepEqual(guiPermissionModes('antigravity'), []);
  assert.equal(nextGuiPermissionMode('claude', 'supervised'), 'auto-accept-edits');
  assert.equal(nextGuiPermissionMode('claude', 'full-access'), 'supervised');
  assert.equal(nextGuiPermissionMode('pi', 'supervised'), 'supervised');
  assert.equal(parseGuiPermissionMode('auto'), 'auto');
  assert.equal(parseGuiPermissionMode('bypassPermissions'), undefined);
  assert.equal(isPermissionModeShortcut({ key: 'A', metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }), true);
  assert.equal(isPermissionModeShortcut({ key: 'a', metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }), true);
  assert.equal(isPermissionModeShortcut({ key: 'a', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }), false);
  assert.match(permissionModeChangeText('supervised', 'full-access', 'codex'), /Supervised → Full access\. Applies to the next turn/);
  assert.match(permissionModeChangeText('supervised', 'auto', 'claude'), /Applies now/);
});

test('the preset’s unsafe approvals pick the first mode; Codex keeps its workspace-write default', () => {
  assert.equal(initialGuiPermissionMode('claude', false), 'supervised');
  assert.equal(initialGuiPermissionMode('claude', true), 'full-access');
  assert.equal(initialGuiPermissionMode('codex', false), 'auto-accept-edits');
  assert.equal(initialGuiPermissionMode('pi', true), 'full-access');
  assert.deepEqual(['supervised', 'auto-accept-edits', 'auto', 'full-access'].map(claudePermissionMode), ['default', 'acceptEdits', 'auto', 'bypassPermissions']);
  assert.equal(fromClaudePermissionMode('manual'), 'supervised');
  assert.equal(fromClaudePermissionMode('plan'), undefined);
  assert.deepEqual(codexPermissionPolicy('supervised'), { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } });
  assert.equal(codexPermissionPolicy('auto').approvalsReviewer, 'auto_review');
  assert.deepEqual(codexPermissionPolicy('full-access').sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(codexPermissionPolicy('auto-accept-edits').sandbox, 'workspace-write');
});

test('Enter declines only a declinable approval, with a plain message as its note', () => {
  const approval = { method: 'item/commandExecution/requestApproval', id: 'a', params: { command: 'rm -rf build' } };
  const question = { method: 'item/tool/requestUserInput', id: 'q', params: { questions: [{ id: 'choice', question: 'Which?' }] } };
  const noDecline = { method: 'item/commandExecution/requestApproval', id: 'n', params: { availableDecisions: ['accept', 'cancel'] } };
  const draft = { text: 'Use a temp dir instead', attachments: 0 };
  assert.equal(approvalNoteTarget([approval], 'claude', draft), approval);
  assert.equal(approvalNoteTarget([approval], 'codex', draft), approval);
  assert.equal(approvalNoteTarget([question, approval], 'claude', draft), undefined);
  assert.equal(approvalNoteTarget([noDecline], 'codex', draft), undefined);
  assert.equal(approvalNoteTarget([approval], 'claude', { text: '  ', attachments: 0 }), undefined);
  assert.equal(approvalNoteTarget([approval], 'claude', { text: '/goal x', attachments: 0 }), undefined);
  assert.equal(approvalNoteTarget([approval], 'claude', { text: 'note', attachments: 1 }), undefined);
  assert.equal(approvalNoteTarget([], 'claude', draft), undefined);
  assert.equal(declinableApproval([approval], 'antigravity'), undefined);
  assert.deepEqual(['claude', 'codex', 'pi', 'antigravity'].map(approvalNoteDelivery), ['reason', 'follow-up', 'follow-up', 'none']);
  assert.equal(claudeDeclineMessage(''), 'User declined in Aya GUI');
  assert.equal(claudeDeclineMessage(' Use a temp dir '), 'The user declined this tool call and said:\nUse a temp dir');
});

test('Claude declines with the note as its reason, also for a subagent, and a plain decline keeps the fixed reason', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  await session.send('approval-note');
  await wait(() => events.some(e => e.id === 'approve-note'));
  await session.respond('approve-note', { decision: 'decline', note: 'Delete only build/tmp' });
  await wait(() => events.some(e => e.method === 'fixture/permission-answer'));
  assert.deepEqual(events.find(e => e.method === 'fixture/permission-answer').params, { requestId: 'approve-note', behavior: 'deny', message: 'The user declined this tool call and said:\nDelete only build/tmp' });
  await wait(() => !session.running);
  await session.send('background-agent');
  await wait(() => events.some(e => e.id === 'sub-approve'));
  assert.equal(events.find(e => e.id === 'sub-approve').params.subagent, 'Subagent: Read a.txt');
  await session.respond('sub-approve', { decision: 'decline', note: 'Not that file' });
  await wait(() => events.some(e => e.method === 'fixture/permission-answer' && e.params.requestId === 'sub-approve'));
  assert.match(events.find(e => e.params?.requestId === 'sub-approve').params.message, /said:\nNot that file$/);
  await wait(() => !session.running);
  await session.send('approval');
  await wait(() => events.some(e => e.id === 'approve'));
  await session.respond('approve', { decision: 'decline' });
  await wait(() => events.some(e => e.method === 'fixture/permission-answer' && e.params.requestId === 'approve'));
  assert.equal(events.find(e => e.params?.requestId === 'approve').params.message, 'User declined in Aya GUI');
});

test('Claude launches able to reach Full access, switches modes mid-session and follows its own switches', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close());
  const result = await session.connect(process.cwd(), '', undefined, undefined, false, 'auto');
  const args = events.find(e => e.method === 'fixture/config').params.args;
  assert.ok(args.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(result.permissionMode, 'auto');
  assert.deepEqual(events.filter(e => e.method === 'fixture/permission-mode').map(e => e.params.mode), ['auto']);
  await session.setPermissionMode('full-access');
  assert.equal(events.filter(e => e.method === 'fixture/permission-mode').at(-1).params.mode, 'bypassPermissions');
  await session.send('self-mode');
  await wait(() => events.some(e => e.method === 'aya/permissionMode' && e.params.mode === 'auto-accept-edits'));
});

test('Claude refuses a mode its settings forbid and the session keeps its previous mode', async t => {
  process.env.AYA_FAKE_CLAUDE_BYPASS_DISABLED = '1';
  t.after(() => { delete process.env.AYA_FAKE_CLAUDE_BYPASS_DISABLED; });
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close());
  const result = await session.connect(process.cwd(), '', undefined, undefined, false, 'full-access');
  // Launched with --dangerously-skip-permissions, which the preset's unsafe approvals have always used.
  assert.ok(events.find(e => e.method === 'fixture/config').params.args.includes('--dangerously-skip-permissions'));
  assert.equal(result.permissionMode, 'full-access');
  await session.setPermissionMode('supervised');
  await assert.rejects(session.setPermissionMode('full-access'), /disabled by settings/);
});

test('Codex starts a thread in the pane’s mode and sends a changed mode with the next turn only', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close());
  const result = await session.connect(process.cwd(), '', undefined, undefined, false, 'supervised');
  assert.equal(result.permissionMode, 'supervised');
  const config = events.find(e => e.method === 'fixture/config').params;
  assert.deepEqual([config.sandbox, config.approvalPolicy, config.approvalsReviewer], ['read-only', 'untrusted', 'user']);
  await session.send('widgets');
  await wait(() => !session.running);
  const turns = () => events.filter(e => e.method === 'fixture/turn').map(e => e.params);
  assert.equal(turns()[0].approvalPolicy, undefined);
  await session.setPermissionMode('auto');
  await session.send('widgets');
  await wait(() => turns().length === 2 && !session.running);
  assert.deepEqual([turns()[1].approvalPolicy, turns()[1].approvalsReviewer, turns()[1].sandboxPolicy], ['on-request', 'auto_review', { type: 'workspaceWrite' }]);
  await session.send('widgets');
  await wait(() => turns().length === 3 && !session.running);
  assert.equal(turns()[2].sandboxPolicy, undefined);
});

test('a Codex decline lets the turn go on, so the note can steer it', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  await session.send('approval-continue');
  await wait(() => events.some(e => e.id === 'approve-continue'));
  await session.respond('approve-continue', { decision: 'decline', note: 'ignored by Codex' });
  await wait(() => events.some(e => e.method === 'fixture/approval'));
  assert.deepEqual(events.find(e => e.method === 'fixture/approval').params, { decision: 'decline' });
  assert.equal(session.running, true);
  await session.steer('Remove build/tmp only');
  await wait(() => events.some(e => e.method === 'fixture/steer'));
  assert.equal(events.find(e => e.method === 'fixture/steer').params.input[0].text, 'Remove build/tmp only');
});

test('a Codex file change approval names the files its item edits, not the raw request', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close());
  const cwd = await mkdtemp(path.join(tmpdir(), 'aya-file-approval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await session.connect(cwd, '');
  await session.send('file-approval');
  await wait(() => events.some(e => e.method === 'item/fileChange/requestApproval'));
  const request = events.find(e => e.method === 'item/fileChange/requestApproval');
  assert.deepEqual(request.params.files, ['notes.md']);
  assert.equal(approvalSummary(request.params), 'Edit notes.md');
  assert.equal(approvalSummary({ files: ['a.ts'], reason: 'Needs write access' }), 'Edit a.ts\nNeeds write access');
  assert.equal(approvalSummary({ command: 'git status', reason: 'Check' }), 'git status');
  assert.equal(approvalSummary({ itemId: 'x' }), JSON.stringify({ itemId: 'x' }, null, 2));
});

test('a Claude mode switch answers the pending approvals the new mode would not ask about, and says which still wait', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  await session.send('edit-approval');
  await wait(() => events.some(e => e.id === 'approve-edit') && events.some(e => e.id === 'approve-bash'));
  const answers = () => events.filter(e => e.method === 'fixture/permission-answer').map(e => [e.params.requestId, e.params.behavior]);
  await session.setPermissionMode('auto-accept-edits');
  await wait(() => answers().length === 1);
  assert.deepEqual(answers(), [['approve-edit', 'allow']]);
  assert.ok(events.some(e => e.method === 'aya/requestResolved' && e.params.id === 'approve-edit'));
  assert.match(events.filter(e => e.method === 'aya/notice').at(-1).params.message, /An approval asked for before the switch still needs an answer: Auto-accept edits/);
  await session.setPermissionMode('full-access');
  await wait(() => answers().length === 2);
  assert.deepEqual(answers()[1], ['approve-bash', 'allow']);
});

test('a Codex mode switch accepts the pending approvals the new mode would not ask about', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close());
  const cwd = await mkdtemp(path.join(tmpdir(), 'aya-switch-approval-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await session.connect(cwd, '', undefined, undefined, false, 'supervised');
  await session.send('file-approval');
  await wait(() => events.some(e => e.method === 'item/fileChange/requestApproval'));
  await session.setPermissionMode('auto-accept-edits');
  await wait(() => events.some(e => e.method === 'fixture/approval'));
  assert.deepEqual(events.find(e => e.method === 'fixture/approval').params, { decision: 'accept' });
  await wait(() => !session.running);
  await session.send('approval-continue');
  await wait(() => events.some(e => e.id === 'approve-continue'));
  await session.setPermissionMode('auto');
  assert.match(events.filter(e => e.method === 'aya/notice').at(-1).params.message, /still needs an answer: Auto applies/);
  assert.equal(events.filter(e => e.method === 'fixture/approval').length, 1);
  await session.setPermissionMode('full-access');
  await wait(() => events.filter(e => e.method === 'fixture/approval').length === 2);
  assert.deepEqual(events.filter(e => e.method === 'fixture/approval')[1].params, { decision: 'accept' });
});
