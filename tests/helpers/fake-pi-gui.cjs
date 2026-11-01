#!/usr/bin/env node
const readline = require('node:readline');

let busy = false;
let lastArtifactId = '';
let progressId = '';
let progressStep = 0;
let holdProgress = false;
let currentModel = 'fake-pi';
let currentEffort = 'high';

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');

const complete = (text) => {
  write({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: text },
  });
  write({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  write({ type: 'agent_settled', aborted: false });
  busy = false;
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const type = message.type;

  if (type === 'get_state') {
    write({
      method: 'fixture/config',
      params: { args: process.argv.slice(2), cwd: message.cwd },
    });
    write({
      id: message.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        sessionId: message.sessionId || 'pi-test-thread',
        model: { id: 'fake-pi', name: 'Fake Pi', provider: 'pi-provider', reasoning: true },
        thinkingLevel: currentEffort,
      },
    });
    return;
  }

  if (type === 'get_available_models') {
    write({
      id: message.id,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          {
            id: 'fake-pi',
            name: 'Fake Pi',
            provider: 'pi-provider',
            reasoning: true,
            thinkingLevelMap: { low: 'low', high: 'high' },
          },
          {
            id: 'fake-pi-pro',
            name: 'Fake Pi Pro',
            provider: 'pi-provider',
            reasoning: true,
            thinkingLevelMap: { high: 'high', max: 'max' },
          },
        ],
      },
    });
    return;
  }

  if (type === 'set_model') {
    currentModel = message.modelId || currentModel;
    write({ id: message.id, type: 'response', command: 'set_model', success: true, data: {} });
    return;
  }

  if (type === 'set_thinking_level') {
    currentEffort = message.level || currentEffort;
    write({
      id: message.id,
      type: 'response',
      command: 'set_thinking_level',
      success: true,
      data: {},
    });
    return;
  }

  if (type === 'steer') {
    write({ id: message.id, type: 'response', command: 'steer', success: true, data: {} });
    write({ method: 'fixture/steer', params: { message: message.message } });
    return;
  }

  if (type === 'compact') {
    write({ id: message.id, type: 'response', command: 'compact', success: true, data: {} });
    return;
  }

  if (type === 'side_question') {
    write({
      id: message.id,
      type: 'response',
      command: 'side_question',
      success: true,
      data: { text: 'A separate side answer from Pi' },
    });
    return;
  }

  if (type === 'abort') {
    write({ id: message.id, type: 'response', command: 'abort', success: true, data: {} });
    write({ type: 'agent_settled', aborted: true });
    busy = false;
    return;
  }

  if (type === 'prompt') {
    busy = true;
    const prompt = message.message || '';
    write({
      method: 'fixture/turn',
      params: {
        model: message.model || currentModel,
        effort: message.effort || currentEffort,
        images: message.images || [],
        prompt,
      },
    });
    write({ id: message.id, type: 'response', command: 'prompt', success: true, data: {} });
    write({ type: 'agent_start' });

    if (prompt === 'reopen' || prompt === 'open-missing') {
      write({
        type: 'extension_ui_request',
        id: 'open-artifact',
        method: 'input',
        title: '__aya_tool__:aya_open_artifact',
        placeholder: JSON.stringify({
          artifactId: prompt === 'open-missing' ? 'missing' : lastArtifactId,
        }),
      });
    } else if (prompt === 'html-widget' || prompt === 'update-widget') {
      write({
        type: 'extension_ui_request',
        id: 'present',
        method: 'input',
        title: '__aya_tool__:aya_present',
        placeholder: JSON.stringify({
          kind: 'html',
          title: 'Capacity planner',
          ...(prompt === 'update-widget' ? { artifactId: lastArtifactId } : {}),
          open: true,
          html: `<style>button{padding:12px 20px;background:#b9a6f7;border:0;border-radius:8px}h2{font-weight:500}</style><h2>${prompt === 'update-widget' ? 'Updated capacity' : 'Team capacity'}</h2><p>Choose a scenario to discuss with Pi.</p><button onclick="window.ayaWidget.suggest('Explore a four-person team')">Four-person team</button><p id="sandbox-check"></p><script>document.querySelector('#sandbox-check').textContent = typeof window.aya === 'undefined' ? 'Isolated preview' : 'Unsafe preview';</script>`,
        }),
      });
    } else if (prompt === 'graphic') {
      write({
        type: 'extension_ui_request',
        id: 'present',
        method: 'input',
        title: '__aya_tool__:aya_present',
        placeholder: JSON.stringify({
          kind: 'image',
          title: 'Aya mark',
          path: 'graphic.svg',
          open: true,
        }),
      });
    } else if (prompt === 'progress' || prompt === 'progress-wait') {
      progressStep = 0;
      holdProgress = prompt === 'progress-wait';
      write({
        type: 'extension_ui_request',
        id: 'progress',
        method: 'input',
        title: '__aya_tool__:aya_progress',
        placeholder: JSON.stringify({
          label: 'Decompiling functions',
          current: 0,
          total: 10,
          detail: 'Reading the function list',
        }),
      });
    } else if (prompt === 'complete-goal') {
      complete('The goal is complete. <!-- GOAL_COMPLETE -->');
    } else if (prompt === 'approval') {
      write({
        type: 'extension_ui_request',
        id: 'approve',
        method: 'confirm',
        title: 'Test approval',
        message: 'echo hello',
      });
    } else if (prompt === 'wait') {
      return;
    } else if (prompt === 'question') {
      write({
        type: 'extension_ui_request',
        id: 'question',
        method: 'input',
        title: '__aya_tool__:ask_user_question',
        placeholder: JSON.stringify({
          questions: [
            {
              id: 'choice',
              question: 'Which option?',
              options: [{ label: 'A', description: 'First' }],
            },
          ],
        }),
      });
    } else {
      write({
        type: 'extension_ui_request',
        id: 'present',
        method: 'input',
        title: '__aya_tool__:aya_present',
        placeholder: JSON.stringify({
          open: prompt === 'open-widget',
          kind: 'table',
          title: prompt === 'open-widget' ? 'Opened by Pi' : 'A real tool result',
          columns: ['Name', 'State'],
          rows: [['Aya', 'Ready']],
        }),
      });
    }
    return;
  }

  if (type === 'extension_ui_response') {
    if (message.id === 'progress') {
      const result = JSON.parse(message.value || '{}');
      const inner = JSON.parse(result.text || '{}');
      progressId = inner.progressId;
      if (holdProgress && progressStep === 1) return;
      if (++progressStep <= 2) {
        write({
          type: 'extension_ui_request',
          id: 'progress',
          method: 'input',
          title: '__aya_tool__:aya_progress',
          placeholder: JSON.stringify({
            progressId,
            label: 'Decompiling functions',
            current: progressStep === 1 ? 4 : 10,
            total: 10,
            detail:
              progressStep === 1
                ? 'Decompiled four functions'
                : 'All ten functions are ready',
          }),
        });
      } else {
        complete('All functions have been decompiled.');
      }
      return;
    }
    if (message.id === 'approve') {
      complete(message.confirmed ? 'accept' : 'decline');
      return;
    }
    if (message.id === 'question') {
      complete(message.value || '');
      return;
    }
    if (message.id === 'open-artifact') {
      const parsed = JSON.parse(message.value || '{}');
      complete(parsed.success ? 'Artifact opened' : 'Unknown artifact');
      return;
    }
    if (message.id === 'present') {
      const parsed = JSON.parse(message.value || '{}');
      lastArtifactId = (parsed.text || '').match(/artifactId: ([^.]+)\./)?.[1] || '';
      complete(
        parsed.success
          ? '## Wynik\n\nTabela jest w panelu artefaktów.\n\n| Element | Stan |\n| --- | --- |\n| Aya | Gotowe |'
          : 'Tool failed',
      );
      return;
    }
  }
});

process.on('SIGTERM', () => process.exit(busy ? 2 : 0));
