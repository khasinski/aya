#!/usr/bin/env node
const readline = require('node:readline');

let busy = false;
let lastArtifactId = '';
let progressId = '';
let progressStep = 0;
let holdProgress = false;
let currentModel = 'fake-claude';
let chromeConnected = process.argv.includes('--chrome');

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');

const complete = (text) => {
  write({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  });
  write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
  });
  busy = false;
};

const callMcpTool = (reqId, name, args) => {
  write({
    type: 'control_request',
    request_id: reqId,
    request: {
      subtype: 'mcp_message',
      server_name: 'aya',
      message: {
        jsonrpc: '2.0',
        id: reqId,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    },
  });
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (editScenario(message)) return;

  if (message.type === 'control_request') {
    const req = message.request || {};
    const subtype = req.subtype;
    if (subtype === 'get_usage') {
      if (req.skip_behaviors !== true) throw Error('Usage must not scan transcript history');
      write({ method: 'fixture/usage', params: { skipBehaviors: req.skip_behaviors } });
      if (process.argv.includes('--usage-unsupported')) {
        write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unknown control request: get_usage' } });
        return;
      }
      const reply = () => write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
        session: { total_cost_usd: 0.125, total_api_duration_ms: 1200, total_duration_ms: 2400, total_lines_added: 3, total_lines_removed: 1,
          model_usage: { 'fake-claude': { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 400, cacheCreationInputTokens: 0 } } },
        subscription_type: 'max', rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 37.5, resets_at: '2026-11-18T18:00:00Z' }, seven_day: { utilization: 80, resets_at: null } }, behaviors: null,
      } } });
      if (process.env.AYA_FAKE_USAGE_DELAY_MS) setTimeout(reply, Number(process.env.AYA_FAKE_USAGE_DELAY_MS));
      else reply();
      return;
    }
    if (['get_chrome_dialog', 'mcp_toggle', 'mcp_reconnect'].includes(subtype)) {
      let response = {};
      if (subtype === 'get_chrome_dialog') response = {
        allowed: true, subscriber: true, wsl: false, installed: true,
        connected: chromeConnected, enabled_by_default: true, paired_browser: 'Test browser',
      };
      else if (req.serverName !== 'claude-in-chrome') throw Error('Wrong Chrome server');
      else chromeConnected = subtype === 'mcp_reconnect' || req.enabled === true;
      const reply = () => write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
      if (subtype === 'get_chrome_dialog' && process.argv.includes('--slow-chrome')) setTimeout(reply, 100);
      else reply();
      return;
    }
    if (subtype === 'initialize') {
      write({
        method: 'fixture/config',
        params: {
          args: process.argv.slice(2),
          configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
          sdkMcpServers: req.sdkMcpServers,
          appendSystemPrompt: req.appendSystemPrompt,
        },
      });
      write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            session_id: 'claude-test-thread',
            model: 'fake-claude',
            models: [
              { value: 'fake-claude', displayName: 'Fake Claude' },
              { value: 'fake-claude-opus', displayName: 'Fake Claude Opus' },
            ],
          },
        },
      });
      if (process.argv.includes('--late-init')) setTimeout(() => write({ type: 'system', subtype: 'init', session_id: 'claude-late-thread', model: 'fake-claude-opus' }), 50);
      return;
    }
    if (subtype === 'set_model') {
      if (req.model === 'unavailable') { write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Model unavailable' } }); return; }
      currentModel = req.model || currentModel;
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
      return;
    }
    if (subtype === 'side_question') {
      write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: { response: 'A separate side answer from Claude' },
        },
      });
      return;
    }
    if (subtype === 'interrupt') {
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
      write({
        type: 'result',
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_streaming',
        is_error: true,
        result: '',
      });
      busy = false;
      return;
    }
    return;
  }

  if (message.type === 'user') {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    const prompt = content.find((c) => c.type === 'text')?.text || '';
    if (prompt.startsWith('/compact')) { complete('Context compacted'); return; }
    if (message.steer) {
      write({ method: 'fixture/steer', params: { prompt } });
      return;
    }
    busy = true;
    write({
      method: 'fixture/turn',
      params: {
        model: message.model || currentModel,
        effort: message.effort || 'high',
        content,
        prompt,
      },
    });

    if (prompt === 'reopen' || prompt === 'open-missing') {
      callMcpTool('open-artifact', 'aya_open_artifact', {
        artifactId: prompt === 'open-missing' ? 'missing' : lastArtifactId,
      });
    } else if (prompt === 'html-widget' || prompt === 'update-widget') {
      callMcpTool('present', 'aya_present', {
        kind: 'html',
        title: 'Capacity planner',
        ...(prompt === 'update-widget' ? { artifactId: lastArtifactId } : {}),
        open: true,
        html: `<style>button{padding:12px 20px;background:#b9a6f7;border:0;border-radius:8px}h2{font-weight:500}</style><h2>${prompt === 'update-widget' ? 'Updated capacity' : 'Team capacity'}</h2><p>Choose a scenario to discuss with Claude.</p><button onclick="window.ayaWidget.suggest('Explore a four-person team')">Four-person team</button><p id="sandbox-check"></p><script>document.querySelector('#sandbox-check').textContent = typeof window.aya === 'undefined' ? 'Isolated preview' : 'Unsafe preview';</script>`,
      });
    } else if (prompt === 'graphic') {
      callMcpTool('present', 'aya_present', {
        kind: 'image',
        title: 'Aya mark',
        path: 'graphic.svg',
        open: true,
      });
    } else if (prompt === 'progress' || prompt === 'progress-wait') {
      progressStep = 0;
      holdProgress = prompt === 'progress-wait';
      callMcpTool('progress', 'aya_progress', {
        label: 'Decompiling functions',
        current: 0,
        total: 10,
        detail: 'Reading the function list',
      });
    } else if (prompt === 'complete-goal') {
      complete('The goal is complete. <!-- GOAL_COMPLETE -->');
    } else if (prompt === 'approval') {
      write({
        type: 'control_request',
        request_id: 'approve',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          tool_use_id: 'tool-bash-1',
          decision_reason: 'Test approval',
          input: { command: 'echo hello' },
        },
      });
    } else if (prompt === 'wait') {
      return;
    } else if (prompt === 'question') {
      write({
        type: 'control_request',
        request_id: 'question',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-q-1',
          input: {
            questions: [
              {
                id: 'choice',
                question: 'Which option?',
                options: [{ label: 'A', description: 'First' }],
              },
            ],
          },
        },
      });
    } else if (prompt === 'question-no-id') {
      write({
        type: 'control_request',
        request_id: 'question-no-id',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-q-2',
          input: {
            questions: [
              {
                header: 'Approach',
                question: 'Which approach should we take?',
                options: [{ label: 'Fast', description: 'Quick path' }, { label: 'Thorough', description: 'Complete path' }],
              },
            ],
          },
        },
      });
    } else {
      callMcpTool('present', 'aya_present', {
        open: prompt === 'open-widget',
        kind: 'table',
        title: prompt === 'open-widget' ? 'Opened by Claude' : 'A real tool result',
        columns: ['Name', 'State'],
        rows: [['Aya', 'Ready']],
      });
    }
    return;
  }

  if (message.type === 'control_response') {
    const resp = message.response || {};
    const reqId = resp.request_id;
    const inner = resp.response || {};

    if (reqId === 'progress') {
      const mcpResult = inner.mcp_response?.result || {};
      const parsed = JSON.parse(mcpResult.content?.[0]?.text || '{}');
      progressId = parsed.progressId;
      if (holdProgress && progressStep === 1) return;
      if (++progressStep <= 2) {
        callMcpTool('progress', 'aya_progress', {
          progressId,
          label: 'Decompiling functions',
          current: progressStep === 1 ? 4 : 10,
          total: 10,
          detail:
            progressStep === 1
              ? 'Decompiled four functions'
              : 'All ten functions are ready',
        });
      } else {
        complete('All functions have been decompiled.');
      }
      return;
    }

    if (reqId === 'approve') {
      complete(inner.behavior === 'allow' ? 'accept' : 'decline');
      return;
    }

    if (reqId === 'question') {
      const ans = inner.updatedInput?.answers?.choice || '';
      complete(ans);
      return;
    }

    if (reqId === 'question-no-id') {
      const ans = inner.updatedInput?.answers?.['Which approach should we take?'] || '';
      complete(ans);
      return;
    }

    if (reqId === 'open-artifact') {
      const mcpResult = inner.mcp_response?.result || {};
      complete(!mcpResult.isError ? 'Artifact opened' : 'Unknown artifact');
      return;
    }

    if (reqId === 'present') {
      const mcpResult = inner.mcp_response?.result || {};
      const text = mcpResult.content?.[0]?.text || '';
      lastArtifactId = text.match(/artifactId: ([^.]+)\./)?.[1] || '';
      complete(
        !mcpResult.isError
          ? '## Wynik\n\nTabela jest w panelu artefaktów.\n\n| Element | Stan |\n| --- | --- |\n| Aya | Gotowe |'
          : 'Tool failed',
      );
      return;
    }
  }
});

process.on('SIGTERM', () => process.exit(busy ? 2 : 0));

// Edit from here (AYA_FAKE_CLAUDE_STATE set): a transcript kept on disk across restarts,
// honoring --resume, --resume-session-at, --fork-session and --session-id like Claude 2.1,
// message uuids from stdin, and rewind_files with file checkpoints.
// Prompts: "note <word>" answers with every note in the transcript; "write <file> <text>" also writes a file.
function editScenario(message) {
  const stateFile = process.env.AYA_FAKE_CLAUDE_STATE;
  if (!stateFile) return false;
  const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
  const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { sessions: {}, files: {} }; } };
  const save = state => fs.writeFileSync(stateFile, JSON.stringify(state));
  if (!editScenario.session) {
    const state = load(), resume = arg('--resume'), at = arg('--resume-session-at');
    let transcript = resume ? (state.sessions[resume] || []).slice() : [];
    if (resume && at) { const cut = transcript.findIndex(entry => entry.uuid === at); if (cut < 0) { process.stderr.write(`No message found with message.uuid of: ${at}\n`); process.exit(1); } transcript = transcript.slice(0, cut + 1); }
    editScenario.session = resume && !process.argv.includes('--fork-session') ? resume : arg('--session-id') || resume;
    state.sessions[editScenario.session] = transcript; save(state);
  }
  const sid = editScenario.session;
  const reply = (id, response) => write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  if (message.type === 'control_request' && message.request?.subtype === 'initialize') {
    write({ method: 'fixture/config', params: { args: process.argv.slice(2), checkpointing: process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING || null } });
    reply(message.request_id, { session_id: sid, model: 'fake-claude', models: [{ value: 'fake-claude', displayName: 'Fake Claude' }] });
    return true;
  }
  if (message.type === 'control_request' && message.request?.subtype === 'rewind_files') {
    const state = load(), transcript = state.sessions[sid] || [], req = message.request;
    const start = transcript.findIndex(entry => entry.uuid === req.user_message_id && entry.type === 'user');
    write({ method: 'fixture/rewind', params: { userMessageId: req.user_message_id, dryRun: req.dry_run === true } });
    if (start < 0 || process.env.AYA_FAKE_CLAUDE_NO_CHECKPOINT === '1') { reply(message.request_id, { canRewind: false, error: 'No file checkpoint found for this message.' }); return true; }
    const changes = transcript.slice(start).filter(entry => entry.type === 'user').flatMap(entry => state.files[entry.uuid] || []);
    if (req.dry_run) { reply(message.request_id, { canRewind: true, filesChanged: [...new Set(changes.map(change => change.path))], insertions: 0, deletions: changes.length }); return true; }
    for (const change of changes.reverse()) { if (change.before === null) fs.rmSync(change.path, { force: true }); else fs.writeFileSync(change.path, change.before); }
    reply(message.request_id, { canRewind: true });
    return true;
  }
  if (message.type !== 'user' || message.steer) return false;
  const prompt = (message.message?.content || []).find(c => c.type === 'text')?.text || '';
  if (!/^(note|write) /.test(prompt)) return false;
  const state = load(), transcript = state.sessions[sid] || [];
  const uuid = message.uuid || randomUUID();
  transcript.push({ uuid, type: 'user', text: prompt });
  write({ method: 'fixture/turn', params: { prompt, uuid } });
  if (prompt.startsWith('write ')) {
    const [, name, ...rest] = prompt.split(' '), file = path.join(process.cwd(), name);
    state.files[uuid] = [...(state.files[uuid] || []), { path: file, before: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }];
    fs.writeFileSync(file, rest.join(' '));
  }
  const notes = transcript.filter(entry => entry.type === 'user').map(entry => entry.text.split(' ')[1]);
  const text = `I remember: ${notes.join(', ')}`;
  const assistant = randomUUID();
  transcript.push({ uuid: assistant, type: 'assistant', text });
  state.sessions[sid] = transcript; save(state);
  write({ type: 'system', subtype: 'init', session_id: sid, model: 'fake-claude' });
  write({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  write({ type: 'assistant', uuid: assistant, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
  write({ type: 'result', subtype: 'success', is_error: false, result: text });
  return true;
}
