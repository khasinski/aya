// IPC side of "Edit from here": record what a sent message needs for a later rewind,
// then check and apply the rewind (the agent's checks, then the optional file revert, then the agent's history).
import type { ConversationSnapshot } from './gui-conversation-store';
import { forgetArchivedConversation } from './gui-conversation-store';
import { restoreWorkspaceSnapshot,snapshotAvailable,takeWorkspaceSnapshot,type EditSendInfo,type EditTarget } from './gui-edit-from-here';
import type { GuiSessionInstance } from './multi-agent-gui-session';

interface Entry { session: GuiSessionInstance; cwd: string }
export type FileRevert = { method: 'checkpoint'; count: number } | { method: 'snapshot' } | { method: null; reason: string };

/** Sends a turn; in a git worktree a snapshot of the workspace is taken first, so the turn's file changes can be reverted. */
export async function sendWithSnapshot(entry: Entry, send: () => Promise<EditSendInfo | void>) {
  const snapshot = entry.session.editFromHere ? await takeWorkspaceSnapshot(entry.cwd) : undefined;
  const info = await send();
  return { rewind: { ...(info || {}), ...(snapshot ? { snapshot } : {}) } };
}

const optional = (value: unknown) => typeof value === 'string' && value.length <= 200 ? value : undefined;
export function parseEditTarget(value: unknown): EditTarget {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const target: EditTarget = {};
  if (optional(raw.claudeUser)) target.claudeUser = raw.claudeUser as string;
  if (optional(raw.codexTurn)) target.codexTurn = raw.codexTurn as string;
  if (raw.resumeAt === null) target.resumeAt = null; else if (optional(raw.resumeAt)) target.resumeAt = raw.resumeAt as string;
  if (typeof raw.snapshot === 'string' && /^[0-9a-f]{40,64}$/.test(raw.snapshot)) target.snapshot = raw.snapshot;
  return target;
}

async function fileRevert(entry: Entry, target: EditTarget): Promise<FileRevert> {
  const files = entry.session.previewFileRewind ? await entry.session.previewFileRewind(target) : null;
  if (files) return { method: 'checkpoint', count: files.length };
  if (await snapshotAvailable(entry.cwd, target.snapshot)) return { method: 'snapshot' };
  return { method: null, reason: entry.session.previewFileRewind
    ? 'Claude has no checkpoint for this message inside the workspace, and the pane is not in a git worktree with a snapshot.'
    : 'Files can be reverted only in a git worktree, from a snapshot taken when the message was sent.' };
}

export async function editFromHere(entry: Entry, value: unknown, snapshot: ConversationSnapshot | undefined) {
  const params = value && typeof value === 'object' ? value as { phase?: unknown; target?: unknown; revertFiles?: unknown } : {};
  const session = entry.session;
  if (!session.editFromHere) throw Error('This agent cannot rewind its conversation');
  if (session.running) throw Error('Stop the current turn before editing an earlier message');
  const target = parseEditTarget(params.target);
  if (params.phase !== 'check' && params.phase !== 'apply') throw Error('Invalid edit phase');
  // Everything that can refuse the rewind (the target, the agent's support, running subagents) refuses before files change.
  await session.checkEditFromHere?.(target);
  if (params.phase === 'check') return { files: await fileRevert(entry, target) };
  let filesReverted = false;
  if (params.revertFiles === true) {
    const files = await fileRevert(entry, target);
    if (files.method === 'checkpoint') await session.rewindFiles!(target);
    else if (files.method === 'snapshot') await restoreWorkspaceSnapshot(entry.cwd, target.snapshot!);
    else throw Error(files.reason);
    filesReverted = true;
  }
  const previous = snapshot ? { ...snapshot } : undefined;
  let result: { threadId: string };
  try { result = await session.editFromHere(target); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw Error(filesReverted ? `${message} The files were already restored to how they were before that message.` : message);
  }
  // The archived copy still holds the dropped turns; it is archived again from the shortened view.
  if (previous?.threadId) await forgetArchivedConversation(previous).catch(() => {});
  if (snapshot) snapshot.threadId = result.threadId;
  return { ...result, filesReverted };
}
