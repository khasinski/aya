#!/usr/bin/env node
const readline = require('node:readline');

let busy = false;
let lastArtifactId = '';
let progressId = '';
let progressStep = 0;
let holdProgress = false;
let currentModel = 'fake-claude';

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

  if (message.type === 'control_request') {
    const req = message.request || {};
    const subtype = req.subtype;
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
      return;
    }
    if (subtype === 'set_model') {
      currentModel = req.model || currentModel;
      write({
        type: 'control_response',
        response: { subtype: 'success', request_id: message.request_id, response: {} },
      });
      return;
    }
    if (subtype === 'compact') {
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
          response: { answer: 'A separate side answer from Claude' },
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
        subtype: 'interrupted',
        is_error: false,
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
