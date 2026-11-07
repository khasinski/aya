const common = [
  { name: 'resume', description: 'Choose a saved conversation in this project and account.' },
  { name: 'new', description: 'Start a new conversation; keep this one in history.' },
  { name: 'clear', description: 'Start a new conversation; keep this one in history.' },
  { name: 'help', description: 'Show the commands available for this agent.' },
  { name: 'model', description: 'Choose the model for the next turn.' },
  { name: 'status', description: 'Show connection, goal and queue status.' },
  { name: 'goal', description: 'Set, pause, resume or clear the goal.' },
  { name: 'compact', description: 'Compact the conversation context.' },
];
exports.guiCommands = agent => [
  ...common,
  ...(agent === 'pi' || agent === 'antigravity' ? [] : [{ name: 'btw', description: 'Ask a side question; waits for the current turn to finish.' }]),
];

exports.guiCapabilities = agent => ({ steer: agent !== 'antigravity', sideQuestions: agent === 'codex' || agent === 'claude', sideWhileWorking: agent === 'codex' });
