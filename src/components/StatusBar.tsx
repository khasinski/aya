import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import type {
  GitChangedFile,
  GitHubLink,
  ProjectConfig,
  TerminalState,
  WorktreeStatus,
  DiffComment,
} from "../types";
import { diffFileLineIndex } from "../diff-navigation";
import {
  commentRowIndexInDiff,
  diffCommentSendError,
  indexDiffRows,
  type DiffAnchor,
  type ReviewTarget,
} from "../diff-review";
import type { SettingsTab } from "../settings-tabs";
import { MachinesStatus } from "./MachinesStatus";
import { uuid } from "../uuid";
import { printable } from "../printable";

// Material Symbols small icon size (px) used for status-bar glyphs
const ICON_SIZE_SM_PX = 13;

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface Props {
  project: ProjectConfig | null;
  git: GitInfo | null;
  /** The checkout `git` describes and the changed files / diff are read from:
   *  what the user pinned, else where the active terminal's console actually
   *  is, else its spawn cwd. null for remote projects (no local working tree). */
  gitDirectory: string | null;
  /** Worktrees of the active project (branch + dirty count), for the checkout
   *  picker. Fewer than 2 entries = nothing to pick, no picker. */
  worktrees: WorktreeStatus[];
  /** True while `gitDirectory` comes from a pin rather than from the console. */
  checkoutPinned: boolean;
  /** Pin a checkout by path, or null to go back to following the console. */
  onPickCheckout: (path: string | null) => void;
  githubLink: GitHubLink | null;
  showGitHubLink: boolean;
  terminal: TerminalState | null;
  attentionCount: number;
  onGitStatusRefresh: (directory: string) => Promise<void>;
  snippetsOpen: boolean;
  snippetsDisabled: boolean;
  /** Agent panes of the active project a diff review can go to, the default
   *  first. Empty: comments can be written, not sent. */
  reviewTargets: ReviewTarget[];
  onOpenProjectDirectory: (directory: string) => void;
  onToggleSnippets: () => void;
  onOpenAttentionCenter: () => void;
  onOpenTeams: () => void;
  onOpenSettings: (tab: SettingsTab) => void;
  /** Opens a tab running ssh to a machine; absent with no project to open it in. */
  onOpenMachineTerminal?: (sshTarget: string) => void;
}

/** Last path segment — how a worktree is named in the UI (git itself has no
 *  name for one; the directory is its identity). */
function checkoutName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function StatusBarImpl({
  project,
  git,
  gitDirectory,
  worktrees,
  checkoutPinned,
  onPickCheckout,
  githubLink,
  showGitHubLink,
  terminal,
  attentionCount,
  onGitStatusRefresh,
  snippetsOpen,
  snippetsDisabled,
  reviewTargets,
  onOpenProjectDirectory,
  onToggleSnippets,
  onOpenAttentionCenter,
  onOpenTeams,
  onOpenSettings,
  onOpenMachineTerminal,
}: Props) {
  const waiting = terminal?.status === "waiting";
  // The main checkout's (symlink-resolved) path — the same shape gitDirectory
  // has, since both come from git. Compare against THIS, not project.directory:
  // a project opened at a subdirectory of its repo still resolves its live
  // checkout to the repo root, so project.directory would spuriously read as
  // "a different checkout" and label the main checkout a worktree.
  const mainCheckout =
    worktrees.find((w) => w.isMain)?.path ?? project?.directory ?? null;
  // Non-null only while the git strip describes a checkout other than the
  // main one — then the branch chip says which one, so "main" read from a
  // worktree is never mistaken for the project directory's branch.
  const worktreeName =
    gitDirectory && mainCheckout && gitDirectory !== mainCheckout
      ? checkoutName(gitDirectory)
      : null;
  // A single checkout is not a choice, so the picker only exists from 2 up.
  const canPickCheckout = worktrees.length > 1;
  const externalStatus = terminal?.externalStatus;
  const checkoutRef = useRef<HTMLDivElement>(null);
  const [showCheckouts, setShowCheckouts] = useState(false);
  const dirtyRef = useRef<HTMLDivElement>(null);
  const [showDirtyFiles, setShowDirtyFiles] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<GitChangedFile[]>([]);
  const [selectedDirtyPaths, setSelectedDirtyPaths] = useState<string[]>([]);
  const [dirtyFilesLoading, setDirtyFilesLoading] = useState(false);
  const [dirtySelectionDirectory, setDirtySelectionDirectory] = useState<string | null>(null);
  const gitCheckoutRef = useRef<{ directory: string | null; generation: number }>({ directory: gitDirectory, generation: 0 });
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffQuery, setDiffQuery] = useState("");
  // When set, the diff view scrolls to this file's section once it renders.
  const [scrollToPath, setScrollToPath] = useState<string | null>(null);
  // Review comments on the diff, kept while the popover is closed and reopened
  // (a reload of the diff finds their rows again by content).
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [reviewTargetId, setReviewTargetId] = useState<string | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [sendingComments, setSendingComments] = useState(false);
  const diffCommentsProject = project && !project.remote ? project.slug : null;

  useEffect(() => {
    let current = true;
    setComments([]);
    setCommentError(null);
    if (!diffCommentsProject) { setCommentsLoading(false); return; }
    setCommentsLoading(true);
    void window.aya.listDiffComments(diffCommentsProject).then((saved) => {
      if (current) setComments(saved);
    }).catch((err: unknown) => {
      if (current) setCommentError(err instanceof Error ? err.message : "Aya could not load saved comments.");
    }).finally(() => { if (current) setCommentsLoading(false); });
    return () => { current = false; };
  }, [diffCommentsProject]);

  useEffect(() => {
    if (!showDirtyFiles) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!dirtyRef.current?.contains(event.target as Node)) {
        setShowDirtyFiles(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showDirtyFiles]);

  useEffect(() => {
    if (!showCheckouts) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!checkoutRef.current?.contains(event.target as Node)) {
        setShowCheckouts(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showCheckouts]);

  // A picker that vanished (worktree removed, project switched) must not leave
  // an orphaned dropdown floating over the status bar.
  useEffect(() => {
    if (!canPickCheckout) setShowCheckouts(false);
  }, [canPickCheckout]);

  // Reset on any checkout change, not just a project switch: moving to a tab
  // bound to another worktree must not leave the previous worktree's file list
  // and diff on screen.
  useEffect(() => {
    void window.aya.setActiveGitDirectory(gitDirectory);
  }, [gitDirectory]);

  useLayoutEffect(() => {
    gitCheckoutRef.current = { directory: gitDirectory, generation: gitCheckoutRef.current.generation + 1 };
  }, [gitDirectory]);

  useEffect(() => {
    setShowDirtyFiles(false);
    setDirtyFiles([]);
    setDirtyFilesLoading(false);
    setSelectedDirtyPaths([]);
    setDirtySelectionDirectory(null);
    setCommitMessage("");
    setCommitError(null);
    setShowDiff(false);
    setDiffText("");
    setDiffQuery("");
    setScrollToPath(null);
  }, [gitDirectory]);

  const addReviewComment = async (anchor: DiffAnchor, note: string) => {
    if (!project || !gitDirectory) return;
    const comment: DiffComment = {
      ...anchor,
      id: uuid(),
      checkout: gitDirectory,
      note,
      createdAt: new Date().toISOString(),
      sentAt: null,
      sentTo: null,
    };
    try {
      const saved = await window.aya.addDiffComment(project.slug, comment);
      setComments(saved); setCommentError(null);
    } catch (err) { setCommentError(err instanceof Error ? err.message : "Aya could not save that comment."); throw err; }
  };
  const editReviewComment = async (id: string, note: string) => {
    if (!project) return;
    try { setComments(await window.aya.editDiffComment(project.slug, id, note)); setCommentError(null); }
    catch (err) { setCommentError(err instanceof Error ? err.message : "Aya could not save that comment."); throw err; }
  };
  const deleteReviewComment = async (id: string) => {
    if (!project) return;
    try { setComments(await window.aya.deleteDiffComment(project.slug, id)); setCommentError(null); }
    catch (err) { setCommentError(err instanceof Error ? err.message : "Aya could not delete that comment."); }
  };
  const clearSentReviewComments = async () => {
    if (!project) return;
    try { setComments(await window.aya.clearSentDiffComments(project.slug)); setCommentError(null); }
    catch (err) { setCommentError(err instanceof Error ? err.message : "Aya could not clear sent comments."); }
  };
  const sendReview = async (target: ReviewTarget, ids: string[]) => {
    if (!project || !gitDirectory) return;
    setSendingComments(true);
    try {
      const saved = await window.aya.sendDiffComments({ projectSlug: project.slug, targetId: target.id, checkout: gitDirectory, commentIds: ids });
      setComments(saved); setCommentError(null);
    } catch (err) {
      setCommentError(diffCommentSendError(err, target.name));
    } finally {
      setSendingComments(false);
    }
  };

  const toggleDirtyFiles = async () => {
    if (!gitDirectory) return;
    const directory = gitDirectory;
    const generation = gitCheckoutRef.current.generation;
    setShowDirtyFiles((open) => !open);
    setDirtyFilesLoading(true);
    try {
      await window.aya.setActiveGitDirectory(directory);
      if (gitCheckoutRef.current.directory !== directory || gitCheckoutRef.current.generation !== generation) return;
      const files = await window.aya.getGitChangedFiles(directory);
      if (gitCheckoutRef.current.directory !== directory || gitCheckoutRef.current.generation !== generation) return;
      setDirtyFiles(files);
      setSelectedDirtyPaths(files.map((file) => file.path));
      setDirtySelectionDirectory(directory);
      setCommitError(null);
      setDirtyFilesLoading(false);
    } catch (error) {
      if (gitCheckoutRef.current.directory !== directory || gitCheckoutRef.current.generation !== generation) return;
      setCommitError(error instanceof Error ? error.message : "Aya could not load changed files.");
      setDirtyFilesLoading(false);
    }
  };

  const commitSelectedFiles = async () => {
    if (!gitDirectory || dirtySelectionDirectory !== gitDirectory || committing || selectedDirtyPaths.length === 0 || !commitMessage.trim()) return;
    const directory = dirtySelectionDirectory;
    const generation = gitCheckoutRef.current.generation;
    setCommitting(true);
    setCommitError(null);
    try {
      const result = await window.aya.commitGitFiles({
        directory,
        paths: selectedDirtyPaths,
        message: commitMessage,
      });
      if (gitCheckoutRef.current.directory !== directory || gitCheckoutRef.current.generation !== generation) return;
      if (!result.ok) {
        setCommitError(result.error);
        return;
      }
      if (gitCheckoutRef.current.directory !== directory || gitCheckoutRef.current.generation !== generation) return;
      const files = await window.aya.getGitChangedFiles(directory);
      if (gitCheckoutRef.current.directory !== directory || gitCheckoutRef.current.generation !== generation) return;
      setDirtyFiles(files);
      setSelectedDirtyPaths([]);
      setDirtySelectionDirectory(directory);
      setCommitMessage("");
      await onGitStatusRefresh(directory);
    } catch (err) {
      if (gitCheckoutRef.current.directory === directory && gitCheckoutRef.current.generation === generation) {
        setCommitError(err instanceof Error ? err.message : "Aya could not create the commit.");
      }
    } finally {
      setCommitting(false);
    }
  };

  const loadDiff = () => {
    if (!gitDirectory) return;
    setShowDiff(true);
    setDiffLoading(true);
    void window.aya.getGitDiff(gitDirectory).then((diff) => {
      setDiffText(diff);
      setDiffLoading(false);
    });
  };

  const openDiff = () => {
    setScrollToPath(null);
    loadDiff();
  };

  // Open the full diff but jump straight to the clicked file's section.
  const openDiffAtFile = (path: string) => {
    setScrollToPath(path);
    loadDiff();
  };

  return (
    <footer className="aya-statusbar">
      {project && (
        <button
          className="aya-statusbar-item aya-statusbar-button"
          type="button"
          title="Open project directory"
          onClick={() => onOpenProjectDirectory(project.directory)}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            folder
          </span>
          {project.directory}
        </button>
      )}
      {terminal && waiting && (
        <span className="aya-statusbar-item aya-statusbar-item--warn">
          <span
            style={{
              fontFamily: "Material Symbols Outlined",
              fontSize: ICON_SIZE_SM_PX,
              fontVariationSettings: '"FILL" 1',
            }}
          >
            notifications_active
          </span>
          {terminal.name} is waiting for your approval
        </span>
      )}
      {externalStatus && !waiting && (
        <span
          className={`aya-statusbar-item aya-statusbar-item--agent aya-statusbar-item--agent-${externalStatus.level}`}
          title={new Date(externalStatus.updatedAt).toLocaleString()}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            smart_toy
          </span>
          {externalStatus.on ? `waiting on ${externalStatus.on}: ` : ""}
          {externalStatus.text}
        </span>
      )}
      <div className="aya-statusbar-spacer" />
      <MachinesStatus onManage={() => onOpenSettings("machines")} onOpenTerminal={onOpenMachineTerminal} />
      <button
        data-testid="snippet-toggle"
        className={`aya-statusbar-item aya-statusbar-button aya-pane-snippettoggle aya-statusbar-snippet ${
          snippetsOpen ? "aya-pane-snippettoggle--on" : ""
        }`}
        type="button"
        title={
          snippetsDisabled
            ? "Saved snippets (open a terminal first)"
            : "Saved snippets"
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleSnippets}
        disabled={snippetsDisabled}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          bolt
        </span>
        snippets
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          {snippetsOpen ? "expand_more" : "expand_less"}
        </span>
      </button>
      <button
        data-testid="teams-toggle"
        className="aya-statusbar-item aya-statusbar-button"
        type="button"
        title="Teams: roles and messages between panes"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onOpenTeams}
        disabled={!project}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          groups
        </span>
        teams
      </button>
      <button
        className={`aya-statusbar-item aya-statusbar-button ${
          attentionCount > 0 ? "aya-statusbar-item--warn" : ""
        }`}
        type="button"
        title="Open attention center"
        onClick={onOpenAttentionCenter}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          notifications_active
        </span>
        {attentionCount > 0 ? `${attentionCount} attention` : "activity"}
      </button>
      {git?.branch && (
        <div className="aya-statusbar-popover-host" ref={checkoutRef}>
          <BranchChip
            branch={git.branch}
            worktreeName={worktreeName}
            directory={gitDirectory}
            pinned={checkoutPinned}
            canPick={canPickCheckout}
            open={showCheckouts}
            onToggle={() => setShowCheckouts((open) => !open)}
          />
          {showCheckouts && (
            <div
              className="aya-statusbar-popover aya-statusbar-popover--checkouts"
              role="dialog"
              aria-label="Checkouts"
            >
              <div className="aya-statusbar-popover-title">
                <span>Worktrees</span>
                {checkoutPinned && (
                  <button
                    className="aya-statusbar-popover-action"
                    type="button"
                    onClick={() => {
                      onPickCheckout(null);
                      setShowCheckouts(false);
                    }}
                  >
                    Follow terminal
                  </button>
                )}
              </div>
              <div className="aya-checkout-list">
                {worktrees.map((w) => {
                  // A prunable/bare checkout has no branch to read, so pinning
                  // it would blank the whole git strip (chip + this picker) with
                  // no way back. Show the row for context, but don't let it pin.
                  const pickable = !w.prunable && !w.bare;
                  return (
                  <button
                    className={`aya-checkout-row ${
                      w.path === gitDirectory ? "aya-checkout-row--current" : ""
                    }`}
                    type="button"
                    key={w.path}
                    title={pickable ? w.path : `${w.path} (unavailable)`}
                    disabled={!pickable}
                    onClick={() => {
                      onPickCheckout(w.path);
                      setShowCheckouts(false);
                    }}
                  >
                    <span className="aya-checkout-icon">⑂</span>
                    <span className="aya-checkout-name">
                      {checkoutName(w.path)}
                    </span>
                    {w.isMain && (
                      <span className="aya-worktree-header-tag">main</span>
                    )}
                    <span className="aya-checkout-branch">
                      {w.branch ?? (w.detached ? "detached" : "-")}
                    </span>
                    <span
                      className={`aya-checkout-dirty ${
                        w.dirty > 0 ? "aya-checkout-dirty--warn" : ""
                      }`}
                    >
                      {w.prunable ? "stale" : w.dirty > 0 ? `${w.dirty} dirty` : "clean"}
                    </span>
                  </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {showGitHubLink && githubLink && (
        <button
          className="aya-statusbar-item aya-statusbar-button"
          type="button"
          title={githubLink.url}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void window.aya.openUrl(githubLink.url)}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            {githubLink.kind === "pr" ? "merge" : "open_in_new"}
          </span>
          {githubLink.kind === "pr" ? "PR" : "branch on GitHub"}
        </button>
      )}
      {git && git.dirty > 0 ? (
        <div className="aya-statusbar-popover-host" ref={dirtyRef}>
          <button
            className="aya-statusbar-item aya-statusbar-button aya-statusbar-item--warn"
            type="button"
            title="Show changed files"
            // Inline dropdown — keep terminal focus (same as the top-bar ones).
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleDirtyFiles}
          >
            <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
              edit_note
            </span>
            {git.dirty} dirty
          </button>
          {showDirtyFiles && (
            <div
              className={`aya-statusbar-popover ${showDiff ? "aya-statusbar-popover--diff" : ""}`}
              role="dialog"
              aria-label={showDiff ? "Git diff" : "Changed files"}
            >
              <div className="aya-statusbar-popover-title">
                {showDiff ? (
                  <>
                    <button
                      className="aya-statusbar-popover-back"
                      type="button"
                      title="Back to changed files"
                      onClick={() => {
                        setShowDiff(false);
                        setScrollToPath(null);
                      }}
                    >
                      <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 15 }}>
                        arrow_back
                      </span>
                    </button>
                    Diff
                  </>
                ) : (
                  <>
                    <span>Changed files</span>
                    <button
                      className="aya-statusbar-popover-action"
                      type="button"
                      onClick={openDiff}
                    >
                      Show diff
                    </button>
                  </>
                )}
              </div>
              {showDiff ? (
                <DiffPanel
                  diff={diffText}
                  loading={diffLoading}
                  query={diffQuery}
                  onQueryChange={setDiffQuery}
                  scrollToPath={scrollToPath}
                  onScrolled={() => setScrollToPath(null)}
                  comments={comments}
                  commentsLoading={commentsLoading}
                  commentError={commentError}
                  onAddComment={addReviewComment}
                  onEditComment={editReviewComment}
                  onDeleteComment={deleteReviewComment}
                  onClearSent={clearSentReviewComments}
                  targets={reviewTargets}
                  targetId={reviewTargetId}
                  onTargetChange={setReviewTargetId}
                  sending={sendingComments}
                  onSend={(target, ids) => void sendReview(target, ids)}
                />
              ) : dirtyFilesLoading ? (
                <div className="aya-statusbar-popover-empty">Loading...</div>
              ) : dirtyFiles.length === 0 ? (
                <div className="aya-statusbar-popover-empty">No changed files.</div>
              ) : (
                <>
                  <div className="aya-dirty-file-list">
                    <label className="aya-dirty-file-select-all">
                      <input
                        type="checkbox"
                        aria-label="Select all changed files"
                        checked={selectedDirtyPaths.length === dirtyFiles.length}
                        onChange={(event) => setSelectedDirtyPaths(event.currentTarget.checked ? dirtyFiles.map((file) => file.path) : [])}
                      />
                      <span>Select all</span>
                    </label>
                    {dirtyFiles.map((file) => (
                      <div className="aya-dirty-file-row" key={`${file.status}-${file.path}`}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${file.path}`}
                          checked={selectedDirtyPaths.includes(file.path)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setSelectedDirtyPaths((current) => checked
                              ? [...new Set([...current, file.path])]
                              : current.filter((selected) => selected !== file.path));
                          }}
                        />
                        <span className="aya-dirty-file-status">{file.status}</span>
                        <button
                          className="aya-dirty-file-path-button"
                          type="button"
                          title={`Show ${printable(file.path)} in diff`}
                          onClick={() => openDiffAtFile(file.path)}
                        >
                          <span className="aya-dirty-file-path">{printable(file.path)}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="aya-dirty-commit">
                    <label htmlFor="aya-dirty-commit-message">Commit message</label>
                    <input
                      id="aya-dirty-commit-message"
                      value={commitMessage}
                      onChange={(event) => setCommitMessage(event.currentTarget.value)}
                      onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void commitSelectedFiles(); } }}
                      placeholder="Commit message"
                    />
                    {commitError && <div className="aya-dirty-commit-error" role="alert">{commitError}</div>}
                    <button
                      className="aya-statusbar-popover-action aya-dirty-commit-button"
                      type="button"
                      disabled={committing || dirtySelectionDirectory !== gitDirectory || selectedDirtyPaths.length === 0 || !commitMessage.trim()}
                      onClick={() => void commitSelectedFiles()}
                    >
                      {committing ? "Committing..." : "Commit selected"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ) : git?.branch ? (
        <span
          className="aya-statusbar-item"
          style={{ color: "var(--status-active)" }}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            check_circle
          </span>
          clean
        </span>
      ) : null}
    </footer>
  );
}

/** The branch label. Static text with a single checkout; with more than one it
 *  becomes the picker's trigger, and says whether what you see is pinned or is
 *  following the console. */
function BranchChip({
  branch,
  worktreeName,
  directory,
  pinned,
  canPick,
  open,
  onToggle,
}: {
  branch: string;
  worktreeName: string | null;
  directory: string | null;
  pinned: boolean;
  canPick: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const where = worktreeName ? `Worktree ${directory}` : directory;
  const title = canPick
    ? `${where}\nBranch ${branch}\n${
        pinned ? "Pinned - click to pick another checkout" : "Following the active terminal"
      }`
    : (where ?? undefined);
  const body = (
    <>
      <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
        fork_right
      </span>
      {branch}
      {worktreeName && (
        <span className="aya-statusbar-worktree">⑂ {worktreeName}</span>
      )}
      {pinned && (
        <span
          style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}
          title="Pinned checkout"
        >
          push_pin
        </span>
      )}
    </>
  );
  if (!canPick) {
    return (
      <span className="aya-statusbar-item" title={title}>
        {body}
      </span>
    );
  }
  return (
    <button
      className="aya-statusbar-item aya-statusbar-button"
      data-testid="checkout-picker"
      type="button"
      title={title}
      // Inline dropdown — keep terminal focus (same as the other status-bar
      // popovers).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      {body}
      <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
        {open ? "expand_more" : "expand_less"}
      </span>
    </button>
  );
}

interface DiffLine {
  text: string;
  kind: "file" | "hunk" | "add" | "del" | "ctx" | "meta";
  language: string;
}

function languageForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  const byExtension: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    diff: "diff",
    dockerfile: "dockerfile",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    htm: "xml",
    html: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    lua: "lua",
    md: "markdown",
    mjs: "javascript",
    patch: "diff",
    php: "php",
    pl: "perl",
    plist: "xml",
    pm: "perl",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sass: "scss",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    swift: "swift",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };
  if (lower.endsWith("dockerfile") || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower.endsWith("makefile")) return "makefile";
  return byExtension[ext] ?? "plaintext";
}

function annotateDiff(diff: string): DiffLine[] {
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightCodeHtml(code: string, language: string): string {
  if (!hljs.getLanguage(language)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function markHtmlOccurrences(html: string, query: string): string {
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
      (match) => `<mark>${match}</mark>`,
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

function DiffPanel({
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
}) {
  const lines = useMemo(() => annotateDiff(diff), [diff]);
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
  useEffect(() => {
    if (loading || targetIndex < 0) return;
    targetRef.current?.scrollIntoView({ block: "start" });
    onScrolled();
    // onScrolled clears the target, so this fires once per file selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIndex, loading]);
  return (
    <div className="aya-diff-panel">
      <div className="aya-diff-search">
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 14 }}>search</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search diff"
          spellCheck={false}
        />
        {query.trim() ? <span>{matchCount} matches</span> : null}
      </div>
      {loading ? (
        <div className="aya-statusbar-popover-empty">Loading diff...</div>
      ) : !diff ? (
        <div className="aya-statusbar-popover-empty">No diff available.</div>
      ) : (
        <div className="aya-diff-view">
          {lines.map((line, index) => {
            const prefix = ["add", "del", "ctx"].includes(line.kind) ? line.text.slice(0, 1) : "";
            const code = prefix ? line.text.slice(1) : line.text;
            const highlighted = markHtmlOccurrences(
              highlightCodeHtml(code, line.language),
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
                          if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
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
                    if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
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
}

/** Memoized: App re-renders on every poll tick / terminal status flip; with
 *  the derived props memoized in App (R1) and the handlers useCallback'd,
 *  the shallow compare lets the chrome skip those renders entirely. */
export const StatusBar = memo(StatusBarImpl);
