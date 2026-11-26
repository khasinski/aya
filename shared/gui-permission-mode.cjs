// Permission modes for a Conversation GUI pane. The names and the Codex mapping follow T3 Code's
// runtime modes (https://github.com/pingdotgg/t3code, MIT).
const MODES = [
  { id: 'supervised', label: 'Supervised', description: 'Asks before commands and file changes.' },
  { id: 'auto-accept-edits', label: 'Auto-accept edits', description: 'Allows file edits; asks before other actions.' },
  { id: 'auto', label: 'Auto', description: 'The agent’s automatic review allows routine actions and asks about the rest.' },
  { id: 'full-access', label: 'Full access', description: 'Runs commands and edits without asking.' },
];
const IDS = MODES.map(mode => mode.id);

/** The modes an agent can switch between in the conversation; none when its GUI transport cannot switch. */
exports.guiPermissionModes = agent => agent === 'claude' || agent === 'codex' ? MODES : [];
exports.guiPermissionModeLabel = mode => MODES.find(item => item.id === mode)?.label || 'Supervised';
exports.parseGuiPermissionMode = raw => IDS.includes(raw) ? raw : undefined;
/** What a pane starts in before anyone chose: the preset's unsafe approvals mean Full access. Codex has always run
 *  in its workspace-write sandbox, asking on request, which is Auto-accept edits. */
exports.initialGuiPermissionMode = (agent, unsafe) => unsafe ? 'full-access' : agent === 'codex' ? 'auto-accept-edits' : 'supervised';
exports.nextGuiPermissionMode = (agent, current) => {
  const modes = exports.guiPermissionModes(agent).map(mode => mode.id);
  if (!modes.length) return current;
  return modes[(modes.indexOf(current) + 1) % modes.length];
};

const CLAUDE = { supervised: 'default', 'auto-accept-edits': 'acceptEdits', auto: 'auto', 'full-access': 'bypassPermissions' };
exports.claudePermissionMode = mode => CLAUDE[mode] || 'default';
/** Claude's own mode as a pane mode; undefined for one the pane has no name for, such as plan. */
exports.fromClaudePermissionMode = raw => Object.keys(CLAUDE).find(mode => CLAUDE[mode] === (raw === 'manual' ? 'default' : raw));

/** Codex's approval policy, reviewer and sandbox for a mode: `sandbox` for thread/start, `sandboxPolicy` for turn/start. */
exports.codexPermissionPolicy = mode => {
  if (mode === 'supervised') return { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } };
  if (mode === 'auto') return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } };
  if (mode === 'full-access') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } };
  return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } };
};

/** How a note typed while declining reaches the agent: Claude takes it as the refusal's reason; Codex and Pi decline,
 *  then get it as a message into the running turn. */
exports.approvalNoteDelivery = agent => agent === 'claude' ? 'reason' : agent === 'antigravity' ? 'none' : 'follow-up';
exports.claudeDeclineMessage = note => {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return trimmed ? `The user declined this tool call and said:\n${trimmed}` : 'User declined in Aya GUI';
};
/** Shown when a mode switch leaves approvals the agent asked for before it still waiting for an answer. */
exports.pendingApprovalsNotice = (count, mode) => `${count === 1 ? 'An approval asked for before the switch still needs' : `${count} approvals asked for before the switch still need`} an answer: ${exports.guiPermissionModeLabel(mode)} applies to what the agent asks from now on.`;
