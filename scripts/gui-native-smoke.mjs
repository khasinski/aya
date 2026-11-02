#!/usr/bin/env node
// Opt-in integration checks against the installed CLIs and real configured accounts.
// Only scratch conversations and harmless printf/sleep commands are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { guiCapabilities } from '../shared/gui-commands.cjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const args = process.argv.slice(2);
const selected = (args.find(value => value.startsWith('--agents='))?.split('=')[1] || 'codex,claude,pi,antigravity').split(',');
const cases = (args.find(value => value.startsWith('--cases='))?.split('=')[1] || 'login,resume,permissions,steer,stop,side-question').split(',');
const root = await mkdtemp(path.join(tmpdir(), 'aya-gui-native-'));
process.env.AYA_HOME = path.join(root, 'aya');
const { CodexGuiSession, ClaudeGuiSession, PiGuiSession, AntigravityGuiSession } = await import('../dist-electron/codex-gui-session.js');
const specs = { codex: [CodexGuiSession, 'codex'], claude: [ClaudeGuiSession, 'claude'], pi: [PiGuiSession, 'pi'], antigravity: [AntigravityGuiSession, 'agy'] };
const results = [];
const output = path.join(project, 'test-results', 'reliability', 'gui-native-smoke.json');
async function checkpoint(complete = false) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output + '.tmp', JSON.stringify({ testedAt: new Date().toISOString(), workspace: root, complete, results }, null, 2) + '\n');
  await rename(output + '.tmp', output);
}
await checkpoint();
function check(condition, message) { assert.ok(condition, message); }
async function bounded(promise, description, milliseconds = 90000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${description} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function validResult(event) {
  check(event?.method === 'turn/completed', 'Expected a native completed-turn event');
  check(event.params.turn.status === 'completed', event.params.turn.error?.message || `Turn ended as ${event.params.turn.status}`);
}
function safeCommand(value) {
  const command = Array.isArray(value) ? value.at(-1) : value;
  if (typeof command !== 'string') return false;
  // Native Codex may display the shell wrapper in its approval record.
  const inner = command.replace(/^\/?(?:bin\/)?(?:zsh|bash|sh) -lc /, '').replace(/^(['"])(.*)\1$/, '$2');
  return /^(?:printf\s+['"]?APPROVAL_GUI['"]?|(?:\/bin\/)?sleep (?:3|8|30))$/.test(inner.trim());
}
async function open(spec, cwd, { unsafe = false, resume, forceApproval = false } = {}) {
  const [Session, executable] = specs[spec];
  const events = [], waiters = new Set();
  let threadId = resume;
  const customArgs = spec === 'claude' && forceApproval ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool=stdio', '--permission-mode', 'default', '--settings', JSON.stringify({ permissions: { ask: ['Bash'] } })] : undefined;
  let session;
  session = new Session(event => {
    events.push(event);
    if (event.method === 'aya/session') threadId = event.params.threadId || threadId;
    if (event.method === 'item/commandExecution/requestApproval') {
      const allowed = safeCommand(event.params.command);
      void session.respond(event.id, { decision: allowed ? 'accept' : 'decline' }).catch(error => events.push({ method: 'smoke/error', params: { message: String(error) } }));
      if (!allowed) events.push({ method: 'smoke/error', params: { message: 'Unexpected command approval was declined' } });
    }
    for (const waiter of [...waiters]) if (waiter.predicate(event)) { waiters.delete(waiter); waiter.resolve(event); }
  }, executable, customArgs);
  const connected = await bounded(session.connect(cwd, '', undefined, resume, unsafe), 'Connect');
  threadId ||= connected.threadId;
  return {
    session, events, get threadId() { return threadId; },
    wait(predicate) {
      const previous = events.find(predicate);
      if (previous) return Promise.resolve(previous);
      return new Promise(resolve => waiters.add({ predicate, resolve }));
    },
    answer() {
      const completed = events.filter(event => event.method === 'item/completed' && event.params.item?.type === 'agentMessage');
      return completed.at(-1)?.params.item.text || events.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta || '').join('');
    },
    reset() { events.length = 0; },
    async close() {
      // Wait for the real process to flush its conversation before resuming it.
      const child = session.child;
      const exited = child && child.exitCode === null ? new Promise(resolve => child.once('close', resolve)) : Promise.resolve();
      session.close();
      await bounded(exited, 'Agent shutdown', 5000);
    },
  };
}
async function send(client, prompt) {
  await bounded(client.session.send(prompt), 'Send');
  const ended = await bounded(client.wait(event => event.method === 'turn/completed' || event.method === 'aya/disconnected' || event.method === 'smoke/error'), 'Answer');
  validResult(ended);
  return client.answer();
}
async function runningShell(client, seconds) {
  const sending = client.session.send(`Run exactly \`sleep ${seconds}\` using your shell tool now. Do not read files, run other commands, or invoke subagents. After it finishes reply DONE_GUI.`);
  const event = await bounded(client.wait(event => (event.method === 'item/started' && event.params.item?.type === 'commandExecution') || event.method === 'turn/completed' || event.method === 'aya/disconnected' || event.method === 'smoke/error'), 'Start shell');
  check(event.method === 'item/started', 'The client did not start the requested shell command');
  await bounded(sending, 'Prompt acknowledgement');
}
for (const agent of selected) {
  if (!specs[agent]) throw Error(`Unknown agent ${agent}`);
  let version = '';
  try { version = (await exec(specs[agent][1], ['--version'], { timeout: 10000 })).stdout.trim(); }
  catch (error) { results.push({ agent, case: 'installation', passed: false, error: String(error) }); await checkpoint(); continue; }
  for (const name of cases) {
    const cwd = path.join(root, agent, name); await mkdir(cwd, { recursive: true });
    let client;
    const startedAt = Date.now();
    try {
      client = await open(agent, cwd, { unsafe: name !== 'permissions', forceApproval: name === 'permissions' });
      if (name === 'login') {
        check((await send(client, 'Reply exactly READY_GUI. Do not use tools or read files.')).includes('READY_GUI'), 'The authenticated client returned no answer');
      } else if (name === 'resume') {
        const code = 'GUI_' + randomUUID().slice(0, 8);
        await send(client, `Remember code ${code}. Reply READY only, without tools or reading files.`);
        const id = client.threadId; await client.close();
        client = await open(agent, cwd, { unsafe: true, resume: id });
        check((await send(client, 'What code did I ask you to remember? Reply only with the code. Do not use tools or read files.')).includes(code), 'Conversation context was not resumed');
      } else if (name === 'permissions') {
        const escalation = agent === 'codex' ? ' Explicitly set sandbox_permissions to require_escalated and justification to "GUI permission smoke test".' : '';
        const prompt = `Run exactly \`printf APPROVAL_GUI\` using your shell tool.${escalation} Do not read files, run other commands, or invoke subagents. Then reply APPROVAL_GUI.`;
        if (agent === 'antigravity') {
          await client.session.send(prompt);
          const denied = await bounded(client.wait(event => event.method === 'turn/completed' || event.method === 'aya/disconnected'), 'Permission refusal');
          check(denied.params?.turn?.status === 'failed' && /headless protocol cannot prompt/.test(denied.params.turn.error?.message || ''), 'Headless denial was not reported honestly');
        } else {
          check((await send(client, prompt)).includes('APPROVAL_GUI'), 'The approved command returned no confirmation');
          check(client.events.some(event => event.method === 'item/commandExecution/requestApproval'), 'No real permission request was observed');
        }
        await client.close(); client = await open(agent, cwd, { unsafe: true });
        check((await send(client, 'Run exactly `printf APPROVAL_GUI` using your shell tool. Do not read files or use other commands. Then reply APPROVAL_GUI.')).includes('APPROVAL_GUI'), 'Skip-permissions command failed');
        check(!client.events.some(event => event.method === 'item/commandExecution/requestApproval'), 'Skip permissions still requested approval');
      } else if (name === 'steer') {
        if (!guiCapabilities(agent).steer) {
          await assert.rejects(client.session.steer('Focus on this'), /does not support steering/);
          results.push({ agent, version, case: name, passed: true, availability: 'unsupported by native headless protocol' });
          console.log(`PASS ${agent} ${name} (correctly unavailable)`);
          continue;
        }
        await runningShell(client, 8);
        await client.session.steer('When the sleep finishes, reply exactly STEER_GUI instead of DONE_GUI. Do not use any more tools.');
        validResult(await bounded(client.wait(event => event.method === 'turn/completed' || event.method === 'aya/disconnected'), 'Steered answer'));
        check(client.answer().includes('STEER_GUI'), 'The native turn did not apply the steering input');
      } else if (name === 'stop') {
        await runningShell(client, 30);
        await bounded(client.session.interrupt(), 'Stop request', 15000);
        const stopped = await bounded(client.wait(event => event.method === 'turn/completed' || event.method === 'aya/disconnected'), 'Stopped turn', 15000);
        check(stopped.params?.turn?.status === 'interrupted', 'Stop was not reported as an interruption');
      } else if (name === 'side-question') {
        if (!guiCapabilities(agent).sideQuestions) {
          await assert.rejects(client.session.command('btw', 'Side question'), /does not support side questions/);
          results.push({ agent, version, case: name, passed: true, availability: 'unsupported by native protocol' });
          console.log(`PASS ${agent} ${name} (correctly unavailable)`);
          continue;
        }
        await send(client, 'Remember the word FLAMINGO. Reply READY without tools.');
        const answer = await bounded(client.session.command('btw', 'Which word did I ask you to remember? Reply only the word. Do not use tools.'), 'Side answer');
        check(answer.text?.includes('FLAMINGO'), 'The adapter did not return the native side answer');
      } else throw Error(`Unknown case ${name}`);
      results.push({ agent, version, case: name, passed: true, durationMs: Date.now() - startedAt });
    } catch (error) { results.push({ agent, version, case: name, passed: false, error: String(error), durationMs: Date.now() - startedAt }); }
    finally { if (client) await client.close().catch(() => {}); await checkpoint(); }
    const row = results.at(-1); console.log(`${row.passed ? 'PASS' : 'FAIL'} ${agent} ${name}${row.error ? ': ' + row.error : ''}`);
  }
}
await checkpoint(true);
console.log(`Native GUI report: ${output}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
