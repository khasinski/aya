// "Edit from here": which earlier user messages can be rewound to, and where the agent resumes.

/** Recorded on a sent user message: the agent's ids for it, Claude's transcript head after its turn, a workspace snapshot. */
export interface EditInfo { prompt?: string; claudeUser?: string; claudeHead?: string; codexTurn?: string; snapshot?: string }
export interface EditableMessage { id: string; type: string; text: string; delivery?: string; edit?: EditInfo }
export interface EditTarget { claudeUser?: string; codexTurn?: string; resumeAt?: string | null; snapshot?: string }
export interface EditPlan { messageId: string; prompt: string; target: EditTarget; removed: number }

const isSteer = (m: EditableMessage) => m.type === 'user' && !m.edit && m.text.startsWith('↳ ');
/** A user message the agent received as the start of a turn (not a steer, not a failed send). */
const turnStart = (m: EditableMessage) => m.type === 'user' && m.delivery !== 'failed' && !isSteer(m);

/** The rewind for messages[index], or null when this agent or message cannot be rewound. */
export function editPlan(messages: EditableMessage[], index: number, agent: string): EditPlan | null {
  const m = messages[index];
  if (!m || m.type !== 'user' || !m.edit || m.delivery === 'failed' || m.delivery === 'sending') return null;
  const base = { messageId: m.id, prompt: m.edit.prompt ?? m.text, removed: messages.length - index };
  const snapshot = m.edit.snapshot ? { snapshot: m.edit.snapshot } : {};
  if (agent === 'codex') return m.edit.codexTurn ? { ...base, target: { codexTurn: m.edit.codexTurn, ...snapshot } } : null;
  if (agent !== 'claude' || !m.edit.claudeUser) return null;
  const previous = messages.slice(0, index).reverse().find(turnStart);
  // The first turn restarts the session; a later one resumes after the previous turn's last assistant message.
  if (previous && !previous.edit?.claudeHead) return null;
  return { ...base, target: { claudeUser: m.edit.claudeUser, resumeAt: previous ? previous.edit!.claudeHead! : null, ...snapshot } };
}

/** Claude reported where its transcript ends after a turn: remember it on the turn's user message. */
export function recordClaudeHead<T extends EditableMessage>(messages: T[], head: string): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!turnStart(m)) continue;
    if (m.edit?.claudeHead === head) return messages;
    const next = [...messages];
    next[i] = { ...m, edit: { ...m.edit, claudeHead: head } };
    return next;
  }
  return messages;
}

/** The conversation as if the message and everything after it never happened. */
export function messagesBefore<T extends EditableMessage>(messages: T[], messageId: string): T[] {
  const index = messages.findIndex(m => m.id === messageId);
  return index < 0 ? messages : messages.slice(0, index);
}

/** Ids of the messages editPlan accepts, in one pass (the list re-renders while a reply streams). */
export function editableMessageIds(messages: EditableMessage[], agent: string): Set<string> {
  const ids = new Set<string>();
  if (agent !== 'claude' && agent !== 'codex') return ids;
  let previous: EditableMessage | undefined;
  for (const m of messages) {
    if (m.type === 'user' && m.edit && m.delivery !== 'failed' && m.delivery !== 'sending') {
      if (agent === 'codex' ? m.edit.codexTurn : m.edit.claudeUser && (!previous || previous.edit?.claudeHead)) ids.add(m.id);
    }
    if (turnStart(m)) previous = m;
  }
  return ids;
}

export function editSummary(removed: number, agentLabel: string): string {
  const later = removed - 1;
  return `Sending replaces this message${later > 0 ? ` and removes the ${later} after it` : ''} from the conversation and from ${agentLabel}’s history.`;
}
