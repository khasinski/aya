import { useCallback,useRef,useState } from 'react';
import { editSummary,type EditPlan } from '../gui-edit-from-here';
import { ipcMessage } from './use-async-action';

export type FileRevert = { method: 'checkpoint'; count: number } | { method: 'snapshot' } | { method: null; reason: string };
export interface EditState { plan: EditPlan; files: FileRevert | null; revertFiles: boolean }
type Invoke = (action: string, value?: unknown) => Promise<unknown>;

/** The "Edit from here" draft: which message is being replaced and whether its files are reverted too. */
export function useEditFromHere(invoke: Invoke) {
  const [editing, setEditing] = useState<EditState | null>(null);
  const current = useRef<EditState | null>(null);
  current.current = editing;
  const start = useCallback((plan: EditPlan) => {
    setEditing({ plan, files: null, revertFiles: false });
    void invoke('edit-from-here', { phase: 'check', target: plan.target })
      .then(result => (result as { files: FileRevert }).files)
      .catch(error => ({ method: null, reason: ipcMessage(error) }) as FileRevert)
      .then(files => setEditing(old => old?.plan.messageId === plan.messageId ? { ...old, files } : old));
  }, [invoke]);
  const cancel = useCallback(() => setEditing(null), []);
  const setRevertFiles = (revertFiles: boolean) => setEditing(old => old && { ...old, revertFiles: revertFiles && old.files?.method != null });
  /** Rewinds the agent (and the files, when chosen). The caller then drops the messages and sends the new text. */
  const apply = async () => {
    const state = current.current;
    if (!state) throw Error('Nothing is being edited');
    return invoke('edit-from-here', { phase: 'apply', target: state.plan.target, revertFiles: state.revertFiles && state.files?.method != null });
  };
  return { editing, start, cancel, setRevertFiles, apply };
}

function fileDetail(files: FileRevert | null, agentLabel: string) {
  if (!files) return 'Checking whether the files can be restored…';
  if (files.method === 'checkpoint') return `Restores ${files.count === 1 ? 'the file' : `the ${files.count} files`} ${agentLabel} changed with its edit tools since this message. Changes made by shell commands are not restored.`;
  if (files.method === 'snapshot') return 'Restores this folder of the worktree to how it was when the message was sent: files added since are deleted, changed ones are put back, including your own edits. Ignored files are left alone.';
  return files.reason;
}

export function EditFromHereBar({ state, agentLabel, busy, onRevertFiles, onCancel }: { state: EditState; agentLabel: string; busy: boolean; onRevertFiles: (value: boolean) => void; onCancel: () => void }) {
  const available = state.files?.method != null;
  return <div className="aya-gui-edit-bar" role="region" aria-label="Edit from here">
    <div><strong>Editing an earlier message</strong><button type="button" onClick={onCancel}>Cancel edit</button></div>
    <p>{editSummary(state.plan.removed, agentLabel)}</p>
    <label data-disabled={!available || busy}><input type="checkbox" checked={state.revertFiles} disabled={!available || busy} onChange={e => onRevertFiles(e.target.checked)} />Also revert files</label>
    <small>{busy ? 'Stop the current turn before sending the edit.' : fileDetail(state.files, agentLabel)}</small>
  </div>;
}
