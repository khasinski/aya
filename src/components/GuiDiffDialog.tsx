import { memo,useCallback,useEffect,useMemo,useRef,useState } from 'react';
import { createPortal } from 'react-dom';
import type { DiffAnchor } from '../diff-review';
import { reviewCommentsBlock } from '../gui-context';
import { largeFilesText,parseDiffSourceId,repoRelativePath,turnDiffFileCount,turnDiffSummaryText,type TurnDiffSummary } from '../gui-turn-diff';
import type { DiffComment } from '../types';
import { uuid } from '../uuid';
import { DiffPanel,type DiffSource } from './DiffPanel';
import './gui-turn-diff.css';
import { ipcMessage } from './use-async-action';

const SHOWN_FILES = 6;

/** The row a finished turn that changed files leaves in the conversation. */
export function TurnChanges({ summary, onOpen }: { summary: TurnDiffSummary; onOpen: (file: string | null) => void }) {
  const more = turnDiffFileCount(summary) - SHOWN_FILES;
  return <section className="aya-gui-turn-changes" aria-label="Changes in this turn">
    <header><strong>Changes in this turn</strong><small>{turnDiffSummaryText(summary.files, summary.totals)}</small><button type="button" onClick={() => onOpen(null)}>View changes</button></header>
    <ul>{summary.files.slice(0, SHOWN_FILES).map(file => <li key={file.path}><button type="button" title={`Show ${file.path} in the diff`} onClick={() => onOpen(file.path)}><code>{file.path}</code></button><small>{file.additions === null ? 'binary' : <><span className="aya-gui-turn-changes-add">+{file.additions}</span> <span className="aya-gui-turn-changes-del">−{file.deletions}</span></>}</small></li>)}
      {more > 0 && <li><button type="button" onClick={() => onOpen(null)}>{more} more {more === 1 ? 'file' : 'files'}</button></li>}</ul>
    {summary.largeFiles && <p className="aya-gui-turn-changes-large" title={summary.largeFiles.paths.join('\n')}>{largeFilesText(summary.largeFiles)}</p>}
  </section>;
}

interface DiffResult { diff?: string; root?: string; prefix?: string }
interface CommitsResult { label?: string; commits?: { sha: string; short: string; subject: string }[] }

/** A Conversation GUI pane's diff viewer: the changes of one turn (or of the running turn so far), or of one commit
 *  of this branch. Review comments are the project's diff comments; "Send" adds them to this conversation's message. */
export const GuiDiffDialog = memo(function GuiDiffDialog({ terminal, invoke, turns, busy, initialSource, focusFile, onClose, onAddToMessage }: {
  terminal: { id: string; cwd: string; projectSlug: string };
  invoke: (action: string, value?: unknown) => Promise<unknown>;
  turns: readonly TurnDiffSummary[];
  busy: boolean;
  initialSource: string;
  focusFile: string | null;
  onClose: () => void;
  onAddToMessage: (block: string) => void;
}) {
  const [sourceId, setSourceId] = useState(initialSource);
  const [diff, setDiff] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [scrollToPath, setScrollToPath] = useState<string | null>(null);
  const pendingFocus = useRef(focusFile);
  const [commits, setCommits] = useState<CommitsResult>({});
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentError, setCommentError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    let current = true;
    void invoke('diff-commits', { since: turns[0]?.startHead ?? null }).then(result => { if (current) setCommits(result as CommitsResult); }).catch(() => {});
    void window.aya.listDiffComments(terminal.projectSlug).then(saved => { if (current) setComments(saved); })
      .catch((err: unknown) => { if (current) setCommentError(ipcMessage(err) || 'Aya could not load saved comments.'); })
      .finally(() => { if (current) setCommentsLoading(false); });
    return () => { current = false; };
    // Loaded once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let current = true;
    const source = parseDiffSourceId(sourceId, turns);
    setLoading(true); setError(null);
    const request = !source ? Promise.reject(Error('Choose what to show.'))
      : source.kind === 'turn' ? invoke('diff-turn', { start: source.summary.start, end: source.summary.end })
        : source.kind === 'current' ? invoke('diff-turn', {})
          : invoke('diff-commit', { sha: source.sha });
    void request.then(raw => {
      if (!current) return;
      const result = raw as DiffResult;
      setDiff(result.diff || '');
      const file = pendingFocus.current; pendingFocus.current = null;
      if (file && result.root !== undefined) setScrollToPath(repoRelativePath(file, { root: result.root, prefix: result.prefix || '', cwd: terminal.cwd }));
    }).catch((err: unknown) => { if (current) { setDiff(''); setError(ipcMessage(err) || 'Aya could not load this diff.'); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
    // turns only label the sources; a new turn must not reload the diff on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  const listed = useMemo<DiffSource[]>(() => [
    ...(busy ? [{ id: 'current', label: 'Current turn so far', group: 'Turns' }] : []),
    ...turns.map((turn, index) => ({ id: `turn:${turn.id}`, label: `Turn ${index + 1} · ${turnDiffSummaryText(turn.files, turn.totals)}`, group: 'Turns' })).reverse(),
    ...(commits.commits || []).map(commit => ({ id: `commit:${commit.sha}`, label: `${commit.short} ${commit.subject}`, group: commits.label || 'Commits' })),
  ], [busy, turns, commits]);
  // The running turn ended while it was on screen: keep it selectable until another diff is chosen.
  const sources = useMemo(() => listed.some(source => source.id === sourceId) ? listed : [{ id: sourceId, label: sourceId === 'current' ? 'Current turn so far' : 'Selected diff' }, ...listed], [listed, sourceId]);

  // Stable props, so the memoized DiffPanel re-renders only for what it shows.
  const { cwd, projectSlug } = terminal;
  const checkoutComments = useMemo(() => comments.filter(comment => comment.checkout === cwd), [comments, cwd]);
  const addComment = useCallback(async (anchor: DiffAnchor, note: string) => {
    const comment: DiffComment = { ...anchor, id: uuid(), checkout: cwd, note, createdAt: new Date().toISOString(), sentAt: null, sentTo: null };
    try { setComments(await window.aya.addDiffComment(projectSlug, comment)); setCommentError(null); }
    catch (err) { setCommentError(ipcMessage(err) || 'Aya could not save that comment.'); throw err; }
  }, [cwd, projectSlug]);
  const editComment = useCallback(async (id: string, note: string) => {
    try { setComments(await window.aya.editDiffComment(projectSlug, id, note)); setCommentError(null); }
    catch (err) { setCommentError(ipcMessage(err) || 'Aya could not save that comment.'); throw err; }
  }, [projectSlug]);
  const deleteComment = useCallback((id: string) => void window.aya.deleteDiffComment(projectSlug, id).then(setComments).catch((err: unknown) => setCommentError(ipcMessage(err) || 'Aya could not delete that comment.')), [projectSlug]);
  const clearSent = useCallback(() => void window.aya.clearSentDiffComments(projectSlug).then(setComments).catch((err: unknown) => setCommentError(ipcMessage(err) || 'Aya could not clear sent comments.')), [projectSlug]);
  const onScrolled = useCallback(() => setScrollToPath(null), []);
  const targets = useMemo(() => [{ id: terminal.id, projectSlug, name: 'This conversation' }], [terminal.id, projectSlug]);
  const onSend = useCallback((_target: unknown, ids: string[]) => {
    try { onAddToMessage(reviewCommentsBlock(checkoutComments.filter(comment => ids.includes(comment.id)), cwd)); onClose(); }
    catch (err) { setCommentError(ipcMessage(err) || 'Aya could not add these comments.'); }
  }, [checkoutComments, cwd, onAddToMessage, onClose]);

  return createPortal(<div className="aya-gui-diff-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialog} className="aya-gui-diff-dialog" role="dialog" aria-modal="true" aria-label="Changes" tabIndex={-1} onKeyDown={e => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault(); e.stopPropagation(); onClose();
    }}>
      <header><strong>Changes</strong><button type="button" aria-label="Close changes" title="Close (Esc)" onClick={onClose}>×</button></header>
      {error && <div className="aya-diff-comment-error" role="alert">{error}</div>}
      <DiffPanel
        diff={diff}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        scrollToPath={scrollToPath}
        onScrolled={onScrolled}
        comments={checkoutComments}
        commentsLoading={commentsLoading}
        commentError={commentError}
        onAddComment={addComment}
        onEditComment={editComment}
        onDeleteComment={deleteComment}
        onClearSent={clearSent}
        targets={targets}
        targetId={terminal.id}
        onTargetChange={ignoreTarget}
        sending={false}
        onSend={onSend}
        sources={sources}
        sourceId={sourceId}
        onSourceChange={setSourceId}
        emptyText={error ? 'No diff to show.' : 'No changes.'}
      />
    </div>
  </div>, document.body);
});
const ignoreTarget = () => {};
