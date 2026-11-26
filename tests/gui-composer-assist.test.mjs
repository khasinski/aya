// Composer assistance in the Conversation GUI: suggested next prompt, context meter, skills picker.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assistSupported, contextMeterText, contextUsageFromParams, filterSkills, insertSkill, isSkillInvocation, parseSuggestionsPreference, skillPickerKey, skillQueryAt } from '../dist-test/gui-composer-assist.js';
import { claudeContextUsage, claudeSkills, cleanPromptSuggestion, codexContextUsage, codexSkills } from '../dist-electron/gui-composer-assist.js';
const isolatedHome = await mkdtemp(path.join(tmpdir(), 'aya-gui-assist-'));
process.env.AYA_HOME = isolatedHome;
after(() => rm(isolatedHome, { recursive: true, force: true }));
const { CodexGuiSession, ClaudeGuiSession } = await import('../dist-electron/codex-gui-session.js');
const codexFixture = path.resolve('tests/helpers/fake-codex-gui.cjs');
const claudeFixture = path.resolve('tests/helpers/fake-claude-gui.cjs');
const wait = async predicate => { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };
const settle = () => new Promise(r => setTimeout(r, 200));

test('suggestions and skills exist only for agents that provide them; suggestions default on', () => {
  assert.deepEqual(['codex', 'claude', 'pi', 'antigravity'].map(assistSupported), [true, true, false, false]);
  assert.equal(parseSuggestionsPreference(null), true);
  assert.equal(parseSuggestionsPreference('1'), true);
  assert.equal(parseSuggestionsPreference('0'), false);
});

test('a suggestion is one short line, never a delegated-task echo', () => {
  assert.equal(cleanPromptSuggestion('  "Run the\n tests"  '), 'Run the tests');
  assert.equal(cleanPromptSuggestion(null), '');
  assert.equal(cleanPromptSuggestion('Delegated task finished: x'), '');
  assert.equal(cleanPromptSuggestion('x'.repeat(501)), '');
});

test('the context meter shows a percentage of the window, or tokens alone without one', () => {
  assert.deepEqual(contextMeterText({ usedTokens: 64000, maxTokens: 256000 }), { label: '25%', title: 'Context: 64,000 of 256,000 tokens (25%)', percent: 25 });
  assert.equal(contextMeterText({ usedTokens: 300000, maxTokens: 200000 }).percent, 100);
  assert.deepEqual(contextMeterText({ usedTokens: 1530000, maxTokens: null }), { label: '1.5M tokens', title: 'Context: 1,530,000 tokens used', percent: null });
  assert.equal(contextMeterText({ usedTokens: 4200, maxTokens: null }).label, '4k tokens');
  assert.deepEqual(contextUsageFromParams({ usedTokens: 10, maxTokens: 0 }), { usedTokens: 10, maxTokens: null });
  assert.equal(contextUsageFromParams({ usedTokens: 'x' }), null);
});

test('both protocols normalise to used tokens and window', () => {
  assert.deepEqual(claudeContextUsage({ totalTokens: 23966, maxTokens: 1000000, percentage: 2 }), { usedTokens: 23966, maxTokens: 1000000 });
  assert.equal(claudeContextUsage({}), null);
  assert.deepEqual(codexContextUsage({ tokenUsage: { last: { totalTokens: 64000 }, total: { totalTokens: 90000 }, modelContextWindow: null } }), { usedTokens: 64000, maxTokens: null });
});

test('skills come from Claude commands that are not built in and from enabled Codex skills', () => {
  assert.deepEqual(claudeSkills([{ name: 'compact', description: 'x', builtin: true }, { name: 'review', description: 'Review it (claude.ai sync)', argumentHint: '[focus]' }, { name: 'review', description: 'dup' }]),
    [{ name: 'review', description: 'Review it', argumentHint: '[focus]' }]);
  assert.deepEqual(codexSkills({ data: [{ skills: [{ name: 'b', description: 'B long', interface: { shortDescription: 'B' }, enabled: true }, { name: 'off', description: '', enabled: false }, { name: 'a', description: 'A', shortDescription: 'A short' }] }] }),
    [{ name: 'a', description: 'A short' }, { name: 'b', description: 'B' }]);
});

test('typing $ at the caret opens the picker; matches rank by name, then description', () => {
  assert.deepEqual(skillQueryAt('use $rev', 8), { start: 4, end: 8, query: 'rev' });
  assert.deepEqual(skillQueryAt('$', 1), { start: 0, end: 1, query: '' });
  assert.equal(skillQueryAt('costs a$5', 9), null);
  assert.equal(skillQueryAt('use $rev now', 12), null);
  const skills = [{ name: 'deploy', description: 'Ship the review app' }, { name: 'review', description: 'Review code' }, { name: 'docs:review', description: 'Docs' }, { name: 'lint', description: 'Lint' }];
  assert.deepEqual(filterSkills(skills, 'rev').map(s => s.name), ['docs:review', 'review', 'deploy']);
  assert.equal(filterSkills(skills, '').length, 4);
  assert.equal(filterSkills(skills, '', 2).length, 2);
  assert.deepEqual(filterSkills(skills, 'rev', 8, true).map(s => s.name), ['docs:review', 'review'], 'the / menu matches names only');
});

test('Enter takes a skill only after arrowing through the picker; Tab always does', () => {
  // `why is $PATH` + Enter sends the message instead of replacing $PATH with some skill.
  assert.equal(skillPickerKey('Enter', false, false), null);
  assert.equal(skillPickerKey('Enter', false, true), 'pick');
  assert.equal(skillPickerKey('Enter', true, true), null);
  assert.equal(skillPickerKey('Tab', false, false), 'pick');
  assert.equal(skillPickerKey('Tab', true, false), null);
  assert.equal(skillPickerKey('ArrowDown', false, false), 'move');
  assert.equal(skillPickerKey('Escape', false, false), 'dismiss');
  assert.equal(skillPickerKey('a', false, true), null);
});

test('choosing a skill inserts what the agent understands', () => {
  // Codex reads $name anywhere in the message.
  assert.deepEqual(insertSkill('codex', 'please $re now', { start: 7, end: 10, query: 're' }, 'review'), { prompt: 'please $review now', caret: 15 });
  // Claude runs a skill only when /name starts the message.
  assert.deepEqual(insertSkill('claude', 'please $re', { start: 7, end: 10, query: 're' }, 'review'), { prompt: '/review please', caret: 14 });
  assert.deepEqual(insertSkill('claude', '/re', { start: 0, end: 3, query: '' }, 'review'), { prompt: '/review ', caret: 8 });
  assert.deepEqual(insertSkill('codex', '/re', { start: 0, end: 3, query: '' }, 'review'), { prompt: '$review ', caret: 8 });
});

test('a Claude /skill is sent as a message unless a GUI command has that name', () => {
  const skills = [{ name: 'review', description: '' }, { name: 'status', description: '' }];
  assert.equal(isSkillInvocation('claude', '/review the diff', skills, [{ name: 'status' }]), true);
  assert.equal(isSkillInvocation('claude', '/status', skills, [{ name: 'status' }]), false);
  assert.equal(isSkillInvocation('claude', '/unknown', skills), false);
  assert.equal(isSkillInvocation('codex', '/review', skills), false);
});

test('Claude: suggestions are requested at initialize, skills come from its commands, context is read after connect and each turn', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close());
  session.setPromptSuggestions(true);
  await session.connect(process.cwd(), '');
  assert.equal(events.find(e => e.method === 'fixture/config').params.promptSuggestions, true);
  assert.deepEqual((await session.skills()).map(s => s.name), ['docs:write', 'fake-review']);
  await wait(() => events.some(e => e.method === 'aya/contextUsage'));
  assert.deepEqual(events.find(e => e.method === 'aya/contextUsage').params, { usedTokens: 12000, maxTokens: 200000 });
  assert.equal(events.find(e => e.method === 'fixture/context-usage').params.detail, 'summary', 'the summary does not call the token-count API');
  await session.send('suggest a change');
  await wait(() => events.some(e => e.method === 'aya/promptSuggestion'));
  assert.equal(events.find(e => e.method === 'aya/promptSuggestion').params.text, 'Now run the tests');
  await wait(() => events.filter(e => e.method === 'aya/contextUsage').length === 2);
  assert.equal(events.filter(e => e.method === 'aya/contextUsage')[1].params.usedTokens, 62000);
});

test('Claude: with suggestions off nothing is requested or shown', async t => {
  const events = [], session = new ClaudeGuiSession(e => events.push(e), process.execPath, [claudeFixture]);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  assert.equal(events.find(e => e.method === 'fixture/config').params.promptSuggestions, false);
  await session.send('suggest a change');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  await settle();
  assert.equal(events.some(e => e.method === 'aya/promptSuggestion'), false);
});

test('Codex: a completed turn samples the next prompt, token usage of this thread drives the meter, skills come from skills/list', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close());
  session.setPromptSuggestions(true);
  await session.connect(process.cwd(), '');
  const skills = await session.skills();
  assert.deepEqual(skills.map(s => s.name), ['fake-deploy', 'lint-fix']);
  assert.equal(skills[0].description, 'Deploy to staging');
  await session.skills();
  assert.equal(events.filter(e => e.method === 'fixture/skills').length, 1, 'the list is cached');
  await session.send('context-usage');
  await wait(() => events.some(e => e.method === 'aya/promptSuggestion'));
  assert.equal(events.find(e => e.method === 'aya/promptSuggestion').params.text, 'Run the tests next');
  const sample = events.find(e => e.method === 'fixture/suggestion-sample').params;
  assert.equal(sample.expectedTurnId, 'turn');
  assert.equal(sample.effort, 'low');
  assert.deepEqual(events.filter(e => e.method === 'aya/contextUsage').map(e => e.params), [{ usedTokens: 64000, maxTokens: 256000 }], 'a child thread does not move the meter');
});

test('Codex: suggestions off never samples', async t => {
  const events = [], session = new CodexGuiSession(e => events.push(e), process.execPath, [codexFixture]);
  t.after(() => session.close());
  await session.connect(process.cwd(), '');
  await session.send('context-usage');
  await wait(() => events.some(e => e.method === 'turn/completed'));
  await settle();
  assert.equal(events.some(e => e.method === 'fixture/suggestion-sample'), false);
});
