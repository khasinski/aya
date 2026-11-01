#!/usr/bin/env node
const readline = require('node:readline');

if (process.argv.includes('models')) {
  process.stdout.write(
    JSON.stringify({
      command: {
        name: 'models',
        status: 'SUCCESS',
        data: {
          models: [
            { id: 'fake-agy', label: 'Fake Antigravity' },
            { id: 'fake-agy-pro', label: 'Fake Antigravity Pro' },
          ],
        },
      },
    }) + '\n',
  );
  process.exit(0);
}

let busy = false;
let stepCounter = 0;
let lastArtifactId = '';
let progressId = '';
let progressStep = 0;
let holdProgress = false;

const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');

write({
  method: 'fixture/config',
  params: { args: process.argv.slice(2), cwd: process.cwd() },
});
const init = () => write({
  event: 'init',
  conversation_id: 'agy-test-thread',
  init: {
    cwd: process.cwd(),
    model: 'fake-agy',
    permission_mode: 'request-review',
  },
});

if (process.argv.includes('--slow-init')) setTimeout(init, 450); else init();

const complete = (text) => {
  const idx = ++stepCounter;
  write({
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-test-thread',
      step_index: idx,
      state: 'ACTIVE',
      step_type: 'agent_response',
      text_delta: text,
    },
  });
  write({
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-test-thread',
      step_index: idx,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: '',
    },
  });
  write({
    event: 'result',
    result: {
      conversation_id: 'agy-test-thread',
      status: 'SUCCESS',
      response: text,
      num_turns: 1,
    },
  });
  busy = false;
};

const emitToolStep = (name, parameters) => {
  const idx = ++stepCounter;
  write({
    event: 'step_update',
    step_update: {
      conversation_id: 'agy-test-thread',
      step_index: idx,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: name,
      tool_info: { name, parameters },
    },
  });
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const evt = message.event;

  if (evt === 'side_question') {
    write({
      event: 'side_answer',
      text: 'A separate side answer from Antigravity',
    });
    return;
  }

  if (evt === 'interrupt') {
    write({
      event: 'result',
      result: {
        conversation_id: 'agy-test-thread',
        status: 'INTERRUPTED',
        finished_reason: 'interrupted',
        response: '',
      },
    });
    busy = false;
    return;
  }

  if (evt === 'approval_response') {
    complete(message.decision || 'decline');
    return;
  }

  if (evt === 'question_response') {
    complete(message.answer || '');
    return;
  }

  if (evt === 'tool_result') {
    if (message.tool_name === 'aya_progress') {
      const parsed = JSON.parse(message.text || '{}');
      progressId = parsed.progressId;
      if (holdProgress && progressStep === 1) return;
      if (++progressStep <= 2) {
        emitToolStep('aya_progress', {
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
    if (message.tool_name === 'aya_open_artifact') {
      complete(message.success ? 'Artifact opened' : 'Unknown artifact');
      return;
    }
    if (message.tool_name === 'aya_present') {
      lastArtifactId = (message.text || '').match(/artifactId: ([^.]+)\./)?.[1] || '';
      complete(
        message.success
          ? '## Wynik\n\nTabela jest w panelu artefaktów.\n\n| Element | Stan |\n| --- | --- |\n| Aya | Gotowe |'
          : 'Tool failed',
      );
      return;
    }
    return;
  }

  if (evt === 'user') {
    const prompt = message.message?.content || '';
    if (message.steer) {
      write({
        method: 'fixture/steer',
        params: { prompt, expectedTurnId: message.expectedTurnId },
      });
      return;
    }
    if (prompt.startsWith('/compact')) {
      return;
    }
    busy = true;
    write({
      method: 'fixture/turn',
      params: {
        model: message.model || 'fake-agy',
        effort: message.effort || 'high',
        images: message.images || [],
        prompt,
      },
    });
    write({
      event: 'step_update',
      step_update: {
        conversation_id: 'agy-test-thread',
        step_index: ++stepCounter,
        state: 'DONE',
        step_type: 'user_input',
      },
    });

    if (prompt === 'reopen' || prompt === 'open-missing') {
      emitToolStep('aya_open_artifact', {
        artifactId: prompt === 'open-missing' ? 'missing' : lastArtifactId,
      });
    } else if (prompt === 'html-widget' || prompt === 'update-widget') {
      emitToolStep('aya_present', {
        kind: 'html',
        title: 'Capacity planner',
        ...(prompt === 'update-widget' ? { artifactId: lastArtifactId } : {}),
        open: true,
        html: `<style>button{padding:12px 20px;background:#b9a6f7;border:0;border-radius:8px}h2{font-weight:500}</style><h2>${prompt === 'update-widget' ? 'Updated capacity' : 'Team capacity'}</h2><p>Choose a scenario to discuss with Antigravity.</p><button onclick="window.ayaWidget.suggest('Explore a four-person team')">Four-person team</button><p id="sandbox-check"></p><script>document.querySelector('#sandbox-check').textContent = typeof window.aya === 'undefined' ? 'Isolated preview' : 'Unsafe preview';</script>`,
      });
    } else if (prompt === 'graphic') {
      emitToolStep('aya_present', {
        kind: 'image',
        title: 'Aya mark',
        path: 'graphic.svg',
        open: true,
      });
    } else if (prompt === 'progress' || prompt === 'progress-wait') {
      progressStep = 0;
      holdProgress = prompt === 'progress-wait';
      emitToolStep('aya_progress', {
        label: 'Decompiling functions',
        current: 0,
        total: 10,
        detail: 'Reading the function list',
      });
    } else if (prompt === 'complete-goal') {
      complete('The goal is complete. <!-- GOAL_COMPLETE -->');
    } else if (prompt === 'approval') {
      emitToolStep('run_command', { CommandLine: 'echo hello' });
      write({
        event: 'result',
        result: {
          conversation_id: 'agy-test-thread',
          status: 'SUCCESS',
          response: '',
          denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
        },
      });
    } else if (prompt === 'wait') {
      return;
    } else if (prompt === 'question') {
      emitToolStep('ask_question', {
        questions: [
          {
            id: 'choice',
            question: 'Which option?',
            options: [{ label: 'A', description: 'First' }],
          },
        ],
      });
    } else {
      emitToolStep('aya_present', {
        open: prompt === 'open-widget',
        kind: 'table',
        title: prompt === 'open-widget' ? 'Opened by Antigravity' : 'A real tool result',
        columns: ['Name', 'State'],
        rows: [['Aya', 'Ready']],
      });
    }
  }
});

process.on('SIGTERM', () => process.exit(busy ? 2 : 0));
