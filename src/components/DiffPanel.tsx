import hljs, { EXT_TO_LANGUAGE } from "../syntax-highlight";
import { memo,useEffect,useMemo,useRef,useState } from "react";
import { diffFileLineIndex } from "../diff-navigation";
import {
  commentRowIndexInDiff,
  indexDiffRows,
  type DiffAnchor,
  type ReviewTarget
} from "../diff-review";
import type {
  DiffComment
} from "../types";


export { EXT_TO_LANGUAGE } from "../syntax-highlight";

export interface DiffSource { id: string; label: string; group?: string }

export interface DiffLine {
  text: string;
  kind: "file" | "hunk" | "add" | "del" | "ctx" | "meta";
  language: string;
}


export function languageForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (lower.endsWith("dockerfile") || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower.endsWith("makefile")) return "makefile";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}


export function annotateDiff(diff: string): DiffLine[] {
  let language = "text";
  return diff.split("\n").map((text) => {
    if (text.startsWith("+++ b/")) language = languageForPath(text.slice(6));
    if (text.startsWith("diff --git")) return { text, kind: "file", language };
    if (text.startsWith("@@")) return { text, kind: "hunk", language };
    if (text.startsWith("+") && !text.startsWith("+++")) return { text, kind: "add", language };
    if (text.startsWith("-") && !text.startsWith("---")) return { text, kind: "del", language };
    if (text.startsWith(" ")) return { text, kind: "ctx", language };
    return { text, kind: "meta", language };
  });
}


export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


export function highlightCodeHtml(code: string, language: string): string {
  if (!hljs.getLanguage(language)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}


export function markHtmlOccurrences(html: string, query: string): string {
  const q = query.trim();
  if (!q) return html;
  let out = "";
  let inTag = false;
  let textBuffer = "";
  const flushText = () => {
    if (!textBuffer) return;
    const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out += textBuffer.replace(
      new RegExp(escapedQuery, "gi"),
      (match) => `<mark class="aya-diff-search-hit">${match}</mark>`,
    );
    textBuffer = "";
  };
  for (const ch of html) {
    if (ch === "<") {
      flushText();
      inTag = true;
      out += ch;
    } else if (ch === ">") {
      inTag = false;
      out += ch;
    } else if (inTag) {
      out += ch;
    } else {
      textBuffer += ch;
    }
  }
  flushText();
  return out;
}


/** Memoized: the Conversation GUI's diff viewer stays open while a reply streams in, and a large diff is many rows. */
export const DiffPanel = memo(function DiffPanel({
  diff,
  loading,
  query,
  onQueryChange,
  scrollToPath,
  onScrolled,
  comments,
  commentsLoading,
  commentError,
  onAddComment,
  onEditComment,
  onDeleteComment,
  onClearSent,
  targets,
  targetId,
  onTargetChange,
  sending,
  onSend,
  sources,
  sourceId,
  onSourceChange,
  emptyText = "No diff available.",
}: {
  diff: string;
  loading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  scrollToPath: string | null;
  onScrolled: () => void;
  comments: DiffComment[];
  commentsLoading: boolean;
  commentError: string | null;
  onAddComment: (anchor: DiffAnchor, note: string) => Promise<void>;
  onEditComment: (id: string, note: string) => Promise<void>;
  onDeleteComment: (id: string) => void;
  onClearSent: () => void;
  targets: ReviewTarget[];
  targetId: string | null;
  onTargetChange: (id: string) => void;
  sending: boolean;
  onSend: (target: ReviewTarget, ids: string[]) => void;
  /** Optional choice of what to show (a turn, a commit...), drawn above the search box. */
  sources?: DiffSource[];
  sourceId?: string;
  onSourceChange?: (id: string) => void;
  emptyText?: string;
}) {
  const lines = useMemo(() => annotateDiff(diff), [diff]);
  const highlightedLines = useMemo(() => lines.map((line) => {
    const prefix = ["add", "del", "ctx"].includes(line.kind) ? line.text.slice(0, 1) : "";
    return highlightCodeHtml(prefix ? line.text.slice(1) : line.text, line.language);
  }), [lines]);
  const rawLines = useMemo(() => diff.split("\n"), [diff]);
  const indexedDiff = useMemo(() => indexDiffRows(rawLines), [rawLines]);
  // Which row is being commented on, and the draft note.
  const [editing, setEditing] = useState<number | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Row -> the comments under it, found again by content after a reload.
  const commentsByRow = useMemo(() => {
    const byRow = new Map<number, DiffComment[]>();
    for (const comment of comments) {
      const row = commentRowIndexInDiff(indexedDiff, comment);
      if (row >= 0) byRow.set(row, [...(byRow.get(row) ?? []), comment]);
    }
    return byRow;
  }, [comments, indexedDiff]);
  const outdated = comments.filter((comment) => commentRowIndexInDiff(indexedDiff, comment) < 0);
  const unsent = comments.filter((comment) => !comment.sentAt);
  const target = targets.find((t) => t.id === targetId) ?? targets[0] ?? null;
  const saveDraft = () => {
    const note = draft.trim();
    const place = editing === null ? null : indexedDiff.anchors[editing];
    if (!note) return;
    const work = editingCommentId
      ? onEditComment(editingCommentId, note)
      : place
        ? onAddComment(place, note)
        : Promise.resolve();
    void work.then(() => { setEditing(null); setEditingCommentId(null); setDraft(""); }).catch(() => {});
  };
  const cancelEdit = () => {
    setEditing(null); setEditingCommentId(null); setDraft("");
  };
  const matchCount = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    return diff.toLowerCase().split(q).length - 1;
  }, [diff, query]);
  // Row to scroll to for the requested file. Line-based index over the same
  // split the rows are rendered from, so it lines up with the rendered rows.
  const targetIndex = useMemo(
    () => (scrollToPath ? diffFileLineIndex(diff, scrollToPath) : -1),
    [diff, scrollToPath],
  );
  const targetRef = useRef<HTMLDivElement | null>(null);
  const diffViewRef = useRef<HTMLDivElement | null>(null);
  const activeHitIndexRef = useRef(0);
  useEffect(() => {
    if (loading || targetIndex < 0) return;
    targetRef.current?.scrollIntoView({ block: "start" });
    onScrolled();
    // onScrolled clears the target, so this fires once per file selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIndex, loading]);
  useEffect(() => {
    activeHitIndexRef.current = 0;
    if (loading || !query.trim()) return;
    const marks = diffViewRef.current?.querySelectorAll<HTMLElement>("mark.aya-diff-search-hit");
    marks?.[0]?.scrollIntoView?.({ block: "center" });
  }, [query, diff, loading]);
  return (
    <div className="aya-diff-panel">
      {sources && sources.length > 0 && (
        <label className="aya-diff-source">
          <span>Show</span>
          <select aria-label="Diff to show" value={sourceId} onChange={(event) => onSourceChange?.(event.target.value)}>
            {[...new Set(sources.map((source) => source.group ?? ""))].map((group) => {
              const options = sources.filter((source) => (source.group ?? "") === group).map((source) => (
                <option key={source.id} value={source.id}>{source.label}</option>
              ));
              return group ? <optgroup key={group} label={group}>{options}</optgroup> : options;
            })}
          </select>
        </label>
      )}
      <div className="aya-diff-search">
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 14 }}>search</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const marks = diffViewRef.current?.querySelectorAll<HTMLElement>("mark.aya-diff-search-hit");
              if (!marks || marks.length === 0) return;
              const delta = event.shiftKey ? -1 : 1;
              activeHitIndexRef.current = (activeHitIndexRef.current + delta + marks.length) % marks.length;
              marks[activeHitIndexRef.current]?.scrollIntoView?.({ block: "center" });
            }
          }}
          placeholder="Search diff"
          spellCheck={false}
        />
        {query.trim() ? <span>{matchCount} matches</span> : null}
      </div>
      {loading ? (
        <div className="aya-statusbar-popover-empty">Loading diff...</div>
      ) : !diff ? (
        <div className="aya-statusbar-popover-empty">{emptyText}</div>
      ) : (
        <div className="aya-diff-view" ref={diffViewRef}>
          {lines.map((line, index) => {
            const prefix = ["add", "del", "ctx"].includes(line.kind) ? line.text.slice(0, 1) : "";
            const highlighted = markHtmlOccurrences(
              highlightedLines[index],
              query,
            );
            const commentable = prefix !== "";
            const anchor = commentable ? indexedDiff.anchors[index] : null;
            const under = commentsByRow.get(index) ?? [];
            return (
              <div key={index}>
                <div
                  className={`aya-diff-view-line aya-diff-view-line--${line.kind} ${
                    under.length || editing === index ? "aya-diff-view-line--commented" : ""
                  }`}
                  ref={index === targetIndex ? targetRef : undefined}
                >
                  <span className="aya-diff-view-gutter">
                    {commentable && (
                      <button
                        className="aya-diff-comment-btn"
                        type="button"
                        title="Comment on this line"
                        aria-label={anchor ? `Comment on ${anchor.file} line ${anchor.newLine ?? anchor.oldLine}` : "Comment on this diff line"}
                        onClick={() => {
                          setEditing(index);
                          setEditingCommentId(null);
                          setDraft("");
                        }}
                      >
                        +
                      </button>
                    )}
                    {index + 1}
                  </span>
                  <span className="aya-diff-view-code">
                    {prefix ? <span className="aya-diff-prefix">{prefix}</span> : null}
                    <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                  </span>
                </div>
                {under.map((comment) => (
                  <div key={comment.id}>
                    <div className="aya-diff-comment">
                      <div className="aya-diff-comment-content">
                        {comment.sentAt ? <span className="aya-diff-comment-sent">Sent to {comment.sentTo}</span> : null}
                        <span className="aya-diff-comment-note">{comment.note}</span>
                      </div>
                      <button className="aya-diff-comment-action" type="button" aria-label={`Edit comment on ${comment.file}`} title="Edit comment" onClick={() => { setEditing(null); setEditingCommentId(comment.id); setDraft(comment.note); }}>Edit</button>
                      <button className="aya-diff-comment-remove" type="button" aria-label={`Delete comment on ${comment.file}`} title="Delete comment" onClick={() => onDeleteComment(comment.id)}>×</button>
                    </div>
                    {editingCommentId === comment.id && (
                      <div className="aya-diff-comment aya-diff-comment--editor">
                        <textarea autoFocus rows={2} value={draft} aria-label="Edit comment" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
                          else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveDraft(); }
                        }} />
                        <div className="aya-diff-comment-actions">
                          <button className="aya-modal-btn aya-modal-btn--primary" type="button" onClick={saveDraft}>Save</button>
                          <button className="aya-modal-btn" type="button" onClick={cancelEdit}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {editing === index && (
                  <div className="aya-diff-comment aya-diff-comment--editor">
                    <textarea
                      autoFocus
                      rows={2}
                      value={draft}
                      placeholder="What should the agent change here? Enter sends, Shift+Enter adds a line, Esc cancels."
                      aria-label="Comment on this diff line"
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelEdit();
                        } else if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          saveDraft();
                        }
                      }}
                    />
                    <div className="aya-diff-comment-actions">
                      <button className="aya-modal-btn aya-modal-btn--primary" type="button" onClick={saveDraft}>
                        Add
                      </button>
                      <button
                        className="aya-modal-btn"
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setDraft("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {outdated.length > 0 && (
        <div className="aya-diff-outdated-list" data-testid="diff-outdated-comments">
          <strong>Outdated comments</strong>
          <p>The line changed since you commented.</p>
          {outdated.map((comment) => (
            <div key={comment.id}>
              <div className="aya-diff-comment aya-diff-comment--outdated">
                <div className="aya-diff-comment-content">
                  {comment.sentAt ? <span className="aya-diff-comment-sent">Sent to {comment.sentTo}</span> : null}
                  <span className="aya-diff-comment-note">
                    {comment.file}:{comment.newLine ?? comment.oldLine} {comment.newLine === null ? "(removed line in HEAD)" : ""}<br />
                    <code>{comment.line}</code><br />{comment.note}
                  </span>
                </div>
                <button className="aya-diff-comment-action" type="button" aria-label={`Edit outdated comment on ${comment.file}`} title="Edit comment" onClick={() => { setEditing(null); setEditingCommentId(comment.id); setDraft(comment.note); }}>Edit</button>
                <button className="aya-diff-comment-remove" type="button" aria-label={`Delete outdated comment on ${comment.file}`} title="Delete comment" onClick={() => onDeleteComment(comment.id)}>×</button>
              </div>
              {editingCommentId === comment.id && (
                <div className="aya-diff-comment aya-diff-comment--editor">
                  <textarea autoFocus rows={2} value={draft} aria-label="Edit comment" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
                    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveDraft(); }
                  }} />
                  <div className="aya-diff-comment-actions">
                    <button className="aya-modal-btn aya-modal-btn--primary" type="button" onClick={saveDraft}>Save</button>
                    <button className="aya-modal-btn" type="button" onClick={cancelEdit}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {commentsLoading && <div className="aya-statusbar-popover-empty">Loading saved comments...</div>}
      {commentError && <div className="aya-diff-comment-error" role="alert">{commentError}</div>}
      {comments.length > 0 && (
        <div className="aya-diff-review-bar" data-testid="diff-review-bar">
          <span className="aya-diff-review-count">
            {unsent.length === 0
              ? `${comments.length} sent`
              : unsent.length === comments.length
                ? `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`
                : `${unsent.length} to send · ${comments.length - unsent.length} sent`}
            {outdated.length > 0 ? ` (${outdated.length} outdated)` : ""}
          </span>
          {comments.some((comment) => comment.sentAt) && <button className="aya-diff-clear-sent" type="button" onClick={onClearSent}>Clear sent</button>}
          <span className="aya-diff-review-spacer" />
          {targets.length === 0 ? (
            <span className="aya-diff-review-hint">No pane in this project to send to.</span>
          ) : (
            <>
              <label className="aya-diff-review-target">
                Send to
                <select value={target?.id ?? ""} onChange={(event) => onTargetChange(event.target.value)}>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <button
                className="aya-modal-btn aya-modal-btn--primary"
                type="button"
                data-testid="diff-review-send"
                disabled={!target || unsent.length === 0 || commentsLoading || sending}
                title="Send the unsent comments to this pane"
                onClick={() => target && onSend(target, unsent.map((comment) => comment.id))}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
});
