import type { GuiEvent } from '../shared/codex-gui';
import { approvalNoteDelivery, guiPermissionModeLabel, type GuiPermissionMode } from '../shared/gui-permission-mode.cjs';

type Agent = 'codex' | 'claude' | 'pi' | 'antigravity';

/** The approval a typed note declines: the first pending request, when it is an approval that offers Decline and
 *  this agent can hear a note. A question is answered in its own card instead. */
export function declinableApproval(requests: GuiEvent[], agent: Agent): GuiEvent | undefined {
  const request = requests[0];
  if (!request || approvalNoteDelivery(agent) === 'none') return undefined;
  if (Array.isArray(request.params.questions) && request.params.questions.length) return undefined;
  const decisions = request.params.availableDecisions;
  if (agent === 'codex' && Array.isArray(decisions) && !decisions.includes('decline')) return undefined;
  return request;
}

/** Enter with a plain message while an approval waits declines it with that message as the reason. A command, an
 *  attachment or an empty draft keeps its usual meaning. */
export function approvalNoteTarget(requests: GuiEvent[], agent: Agent, draft: { text: string; attachments: number }): GuiEvent | undefined {
  if (!draft.text.trim() || draft.text.startsWith('/') || draft.attachments > 0) return undefined;
  return declinableApproval(requests, agent);
}

/** Cmd/Ctrl+Shift+A cycles the permission mode, as in T3 Code. */
export function isPermissionModeShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a';
}

export function permissionModeChangeText(previous: GuiPermissionMode, next: GuiPermissionMode, agent: Agent): string {
  return `${guiPermissionModeLabel(previous)} → ${guiPermissionModeLabel(next)}. ${agent === 'codex' ? 'Applies to the next turn.' : 'Applies now.'}`;
}

/** What an approval asks for: the command, or the files a change edits and why, before falling back to the raw
 *  request (Codex names only the item of a file change; Aya adds its `files`). */
export function approvalSummary(params: Record<string, unknown>): string {
  const files = Array.isArray(params.files) ? params.files.filter((file): file is string => typeof file === 'string') : [];
  const command = typeof params.command === 'string' ? params.command : '', reason = typeof params.reason === 'string' ? params.reason : '';
  return command || [files.length ? `Edit ${files.join(', ')}` : '', reason].filter(Boolean).join('\n') || JSON.stringify(params, null, 2);
}
