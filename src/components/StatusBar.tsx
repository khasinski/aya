import { memo,useCallback,useEffect,useLayoutEffect,useRef,useState } from "react";
import {
	diffCommentSendError,
	type DiffAnchor,
	type ReviewTarget
} from "../diff-review";
import { printable } from "../printable";
import type { SettingsTab } from "../settings-tabs";
import type {
	CiFailurePreview,
	DiffComment,
	GitChangedFile,
	GitHubLink,
	GitPublishStatus,
	ProjectConfig,
	PullRequestChecks,
	TerminalState,
	WorktreeStatus,
} from "../types";
import { uuid } from "../uuid";
import { DiffPanel } from './DiffPanel';
import { MachinesStatus } from "./MachinesStatus";

// Material Symbols small icon size (px) used for status-bar glyphs
const ICON_SIZE_SM_PX = 13;

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface Props {
  onOpenUsage?: () => void;
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
  terminalSoundsEnabled: boolean;
  onTerminalSoundsEnabledChange: (enabled: boolean) => void;
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

function ciCheckLabel(check: PullRequestChecks["checks"][number]): string {
  if (check.bucket === "pass") return "Passed";
  if (check.bucket === "fail") return "Failed";
  if (check.bucket === "pending") {
    if (/queued|waiting|requested|pending/i.test(check.state)) return "Queued";
    if (/in.progress|running/i.test(check.state)) return "Running";
  }
  return check.state;
}

function ciActionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "").trim();
  return message || fallback;
}

function StatusBarImpl({
  onOpenUsage,
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
  terminalSoundsEnabled,
  onTerminalSoundsEnabledChange,
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
  const mobileActionsRef = useRef<HTMLDivElement>(null);
  const [showMobileActions, setShowMobileActions] = useState(false);
  const checkoutRef = useRef<HTMLDivElement>(null);
  const [showCheckouts, setShowCheckouts] = useState(false);
  const dirtyRef = useRef<HTMLDivElement>(null);
  const [showDirtyFiles, setShowDirtyFiles] = useState(false);
  const showDirtyFilesRef = useRef(false);
  const [dirtyFiles, setDirtyFiles] = useState<GitChangedFile[]>([]);
  const [selectedDirtyPaths, setSelectedDirtyPaths] = useState<string[]>([]);
  const [dirtyFilesLoading, setDirtyFilesLoading] = useState(false);
  const [dirtySelectionDirectory, setDirtySelectionDirectory] = useState<string | null>(null);
  const gitCheckoutRef = useRef<{ directory: string | null; generation: number }>({ directory: gitDirectory, generation: 0 });
  const isCurrentGitCheckout = useCallback((directory: string, generation: number) =>
    gitCheckoutRef.current.directory === directory && gitCheckoutRef.current.generation === generation, []);

  useEffect(() => {
    if (!showMobileActions) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!mobileActionsRef.current?.contains(event.target as Node)) setShowMobileActions(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowMobileActions(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showMobileActions]);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitNotice, setCommitNotice] = useState<string | null>(null);
  const [publishStatus, setPublishStatus] = useState<GitPublishStatus | null>(null);
  const publishStatusRequest = useRef<{ requestId: string; directory: string; generation: number } | null>(null);
  const cancelPublishStatusRequest = useCallback(() => {
    const request = publishStatusRequest.current;
    if (!request) return;
    publishStatusRequest.current = null;
    void window.aya.cancelGitPublishStatus(request.requestId).catch(() => {});
  }, []);
  const refreshPublishStatus = useCallback(async (directory: string, generation: number): Promise<GitPublishStatus | null> => {
    cancelPublishStatusRequest();
    const request = { requestId: uuid(), directory, generation };
    publishStatusRequest.current = request;
    try {
      const status = await window.aya.getGitPublishStatus(directory, request.requestId);
      if (publishStatusRequest.current?.requestId !== request.requestId || !isCurrentGitCheckout(directory, generation)) return null;
      setPublishStatus(status);
      return status;
    } catch {
      if (publishStatusRequest.current?.requestId === request.requestId && isCurrentGitCheckout(directory, generation)) setPublishStatus(null);
      return null;
    } finally {
      if (publishStatusRequest.current?.requestId === request.requestId) publishStatusRequest.current = null;
    }
  }, [cancelPublishStatusRequest, isCurrentGitCheckout]);
  const [createdPullRequest, setCreatedPullRequest] = useState<{ directory: string; branch: string | null; url: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [ciChecks, setCiChecks] = useState<PullRequestChecks | null>(null);
  const [ciChecksError, setCiChecksError] = useState<string | null>(null);
  const [ciActionError, setCiActionError] = useState<string | null>(null);
  const ciRetryRef = useRef<(() => void) | null>(null);
  const [ciTargetId, setCiTargetId] = useState<string | null>(null);
  const ciTargetIdRef = useRef<string | null>(null);
  ciTargetIdRef.current = ciTargetId;
  const ciPreviewRequestId = useRef(0);
  const ciActionRequestId = useRef<string | null>(null);
  const [selectedCiCheckUrl, setSelectedCiCheckUrl] = useState<string | null>(null);
  const [ciPreview, setCiPreview] = useState<CiFailurePreview | null>(null);
  const [ciPreviewLoading, setCiPreviewLoading] = useState(false);
  const [ciSending, setCiSending] = useState(false);
  const cancelCiActionRequest = useCallback(() => {
    const requestId = ciActionRequestId.current;
    if (!requestId) return;
    ciActionRequestId.current = null;
    setCiPreviewLoading(false);
    setCiSending(false);
    void window.aya.cancelCiCheckRequest(requestId).catch(() => {});
  }, []);
  const [ciNotice, setCiNotice] = useState<string | null>(null);
  const pullRequestUrl = createdPullRequest?.directory === gitDirectory && createdPullRequest.branch === publishStatus?.branch
    ? createdPullRequest.url
    : (ciChecks?.pullRequestState === "open" || ciChecks?.pullRequestState === "merged" || ciChecks?.pullRequestState === "closed") && publishStatus?.branch
      ? ciChecks.pullRequestUrl
      : null;
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
  const localGitProjectSlug = project && !project.remote ? project.slug : null;

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
    if (!showDirtyFiles && !showDiff) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!dirtyRef.current?.contains(event.target as Node)) {
        setShowDirtyFiles(false);
        setShowDiff(false);
        cancelPublishStatusRequest();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if ((event.target as HTMLElement | null)?.closest?.(".aya-diff-comment--editor")) return;
      event.preventDefault();
      event.stopPropagation();
      setShowDirtyFiles(false);
      setShowDiff(false);
      cancelPublishStatusRequest();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [showDirtyFiles, showDiff, cancelPublishStatusRequest]);

  useEffect(() => {
    if (!showCheckouts) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!checkoutRef.current?.contains(event.target as Node)) {
        setShowCheckouts(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setShowCheckouts(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
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
  useLayoutEffect(() => {
    showDirtyFilesRef.current = showDirtyFiles;
  }, [showDirtyFiles]);

  useEffect(() => {
    setShowDirtyFiles(false);
    setDirtyFiles([]);
    setDirtyFilesLoading(false);
    setSelectedDirtyPaths([]);
    setDirtySelectionDirectory(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitNotice(null);
    setPublishError(null);
    setPublishStatus(null);
    setCreatedPullRequest(null);
    setCiChecks(null);
    setCiChecksError(null);
    setCiActionError(null);
    setSelectedCiCheckUrl(null);
    setCiPreview(null);
    setCiPreviewLoading(false);
    setCiNotice(null);
    setShowDiff(false);
    setDiffText("");
    setDiffQuery("");
    setScrollToPath(null);
  }, [gitDirectory]);

  useEffect(() => () => {
    cancelPublishStatusRequest();
    cancelCiActionRequest();
  }, [gitDirectory, cancelPublishStatusRequest, cancelCiActionRequest]);

  useEffect(() => {
    if (!showDirtyFiles || !gitDirectory || !localGitProjectSlug || !publishStatus?.branch || !publishStatus.remote) {
      setCiChecks(null);
      setCiChecksError(null);
      return;
    }
    const directory = gitDirectory;
    const generation = gitCheckoutRef.current.generation;
    const projectSlug = localGitProjectSlug;
    let active = true;
    const isCurrent = () => active && isCurrentGitCheckout(directory, generation);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let refreshInFlight = false;
    let activeRequestId: string | null = null;
    let delayIndex = 0;
    const delays = [5_000, 10_000, 20_000, 30_000];
    const refresh = async () => {
      if (!active || refreshInFlight) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(refresh, 30_000);
        return;
      }
      refreshInFlight = true;
      const requestId = uuid();
      activeRequestId = requestId;
      try {
        const result = await window.aya.getPullRequestChecks({ projectSlug, directory, requestId });
        if (!isCurrent()) return;
        if (result.error) {
          setCiChecksError(result.error);
        } else {
          setCiChecks(result);
          setCiChecksError(null);
        }
        if (result.pullRequestState === "merged" || result.pullRequestState === "closed") return;
      } catch (error) {
        if (!isCurrent()) return;
        setCiChecksError(error instanceof Error ? error.message : "Aya could not load pull request checks.");
      } finally {
        refreshInFlight = false;
        if (activeRequestId === requestId) activeRequestId = null;
      }
      const delay = delays[Math.min(delayIndex, delays.length - 1)];
      delayIndex += 1;
      timer = setTimeout(refresh, delay);
    };
    const retryNow = () => {
      if (!active) return;
      if (timer) clearTimeout(timer);
      timer = null;
      delayIndex = 0;
      setCiChecksError(null);
      void refresh();
    };
    ciRetryRef.current = retryNow;
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !timer) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      if (activeRequestId) void window.aya.cancelCiCheckRequest(activeRequestId).catch(() => {});
      cancelCiActionRequest();
      setCiPreview(null);
      setSelectedCiCheckUrl(null);
      if (ciRetryRef.current === retryNow) ciRetryRef.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [showDirtyFiles, gitDirectory, localGitProjectSlug, publishStatus?.branch, publishStatus?.remote, isCurrentGitCheckout, cancelCiActionRequest]);

  useEffect(() => {
    if (ciTargetId && reviewTargets.some((target) => target.id === ciTargetId)) return;
    cancelCiActionRequest();
    const targetId = reviewTargets[0]?.id ?? null;
    ciTargetIdRef.current = targetId;
    ciPreviewRequestId.current += 1;
    setCiTargetId(targetId);
    setCiPreview(null);
  }, [reviewTargets, ciTargetId, cancelCiActionRequest]);

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
    const opening = !showDirtyFiles;
    setShowDirtyFiles(opening);
    if (opening) void refreshPublishStatus(directory, generation);
    else cancelPublishStatusRequest();
    setDirtyFilesLoading(true);
    try {
      await window.aya.setActiveGitDirectory(directory);
      if (!isCurrentGitCheckout(directory, generation)) return;
      const files = await window.aya.getGitChangedFiles(directory);
      if (!isCurrentGitCheckout(directory, generation)) return;
      setDirtyFiles(files);
      setSelectedDirtyPaths(files.map((file) => file.path));
      setDirtySelectionDirectory(directory);
      setCommitError(null);
      setDirtyFilesLoading(false);
    } catch (error) {
      if (!isCurrentGitCheckout(directory, generation)) return;
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
      if (!isCurrentGitCheckout(directory, generation)) return;
      if (!result.ok) {
        setCommitError(result.error);
        return;
      }
      setCommitNotice(`Committed ${result.commit.slice(0, 7)}.`);
      setPublishError(null);
      if (showDirtyFilesRef.current) {
        const updatedPublishStatus = await refreshPublishStatus(directory, generation);
        if (!updatedPublishStatus || !isCurrentGitCheckout(directory, generation)) return;
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
      if (isCurrentGitCheckout(directory, generation)) {
        setCommitError(err instanceof Error ? err.message : "Aya could not create the commit.");
      }
    } finally {
      setCommitting(false);
    }
  };

  const pushBranch = async () => {
    if (!gitDirectory || publishing || publishStatus?.pushDisabledReason) return;
    const directory = gitDirectory;
    const generation = gitCheckoutRef.current.generation;
    const isCurrent = () => isCurrentGitCheckout(directory, generation);
    setPublishing(true); setPublishError(null); setCommitNotice(null);
    try {
      const result = await window.aya.pushGitBranch(directory);
      if (!isCurrent()) return;
      if (!result.ok) { setPublishError(result.error); return; }
      await onGitStatusRefresh(directory);
      if (!isCurrent()) return;
      if (showDirtyFilesRef.current) {
        const status = await refreshPublishStatus(directory, generation);
        if (!status || !isCurrent()) return;
      }
      setCommitNotice("Pushed.");
    } catch (error) {
      if (isCurrent()) setPublishError(error instanceof Error ? error.message : "Aya could not push this branch.");
    } finally { setPublishing(false); }
  };

  const openPullRequest = async () => {
    if (!gitDirectory || publishing || publishStatus?.pullRequestDisabledReason) return;
    const directory = gitDirectory;
    const generation = gitCheckoutRef.current.generation;
    const isCurrent = () => isCurrentGitCheckout(directory, generation);
    setPublishing(true); setPublishError(null); setCommitNotice(null);
    try {
      let url = pullRequestUrl;
      if (!url) {
        const result = await window.aya.createGitPullRequest(directory);
        if (!isCurrent()) return;
        if (!result.ok) { setPublishError(result.error); return; }
        url = result.url;
        setCreatedPullRequest({ directory, branch: publishStatus?.branch ?? null, url });
      }
      if (!isCurrent()) return;
      await window.aya.openUrl(url);
      if (isCurrent()) setCommitNotice("Pull request opened.");
    } catch (error) {
      if (isCurrent()) setPublishError(error instanceof Error ? error.message : "Aya could not open the pull request.");
    } finally { setPublishing(false); }
  };

  const previewCiCheck = async (checkUrl: string) => {
    if (!project || !gitDirectory || !ciTargetId) return;
    cancelCiActionRequest();
    const previewGeneration = ++ciPreviewRequestId.current;
    const requestId = uuid();
    ciActionRequestId.current = requestId;
    const directory = gitDirectory;
    const generation = gitCheckoutRef.current.generation;
    const projectSlug = project.slug;
    const targetId = ciTargetId;
    const isCurrent = () => isCurrentGitCheckout(directory, generation);
    setSelectedCiCheckUrl(checkUrl);
    setCommitNotice(null);
    setCiPreview(null);
    setCiPreviewLoading(true);
    setCiNotice(null);
    setCiChecksError(null);
    setCiActionError(null);
    try {
      const preview = await window.aya.previewCiFailure({ projectSlug, directory, targetId, checkUrl, requestId });
      if (!isCurrent() || previewGeneration !== ciPreviewRequestId.current || ciTargetIdRef.current !== targetId || ciActionRequestId.current !== requestId) return;
      setCiPreview(preview);
    } catch (error) {
      if (!isCurrent() || previewGeneration !== ciPreviewRequestId.current || ciTargetIdRef.current !== targetId || ciActionRequestId.current !== requestId) return;
      setCiActionError(ciActionErrorMessage(error, "Aya could not prepare this check for sending."));
    } finally {
      if (ciActionRequestId.current === requestId) {
        ciActionRequestId.current = null;
        setCiPreviewLoading(false);
      }
    }
  };

  const sendCiCheck = async () => {
    if (!project || !ciPreview || !ciTargetId || ciSending) return;
    const directory = gitDirectory;
    const generation = gitCheckoutRef.current.generation;
    const projectSlug = project.slug;
    const targetId = ciTargetId;
    const previewToken = ciPreview.token;
    cancelCiActionRequest();
    const requestId = uuid();
    ciActionRequestId.current = requestId;
    const isCurrent = () => directory !== null && isCurrentGitCheckout(directory, generation);
    setCommitNotice(null);
    setCiSending(true);
    setCiChecksError(null);
    setCiActionError(null);
    setCiNotice("Sending...");
    try {
      await window.aya.sendCiFailure({ projectSlug, targetId, token: previewToken, requestId });
      if (!isCurrent() || ciActionRequestId.current !== requestId) return;
      setCiNotice(`Sent to ${reviewTargets.find((target) => target.id === targetId)?.name ?? "pane"}.`);
      setCiPreview((current) => current?.token === previewToken ? null : current);
    } catch (error) {
      if (!isCurrent() || ciActionRequestId.current !== requestId) return;
      setCiNotice(null);
      setCiPreview((current) => current?.token === previewToken ? null : current);
      setCiActionError(ciActionErrorMessage(error, "Aya could not send the check details."));
    } finally {
      if (ciActionRequestId.current === requestId) {
        ciActionRequestId.current = null;
        setCiSending(false);
      }
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
      {onOpenUsage && <button className="aya-statusbar-item aya-statusbar-button" type="button" aria-label="Open usage" title="Usage · tokens and account limits" onClick={onOpenUsage}><span style={{ fontFamily: "Material Symbols Outlined", fontSize: 14 }}>bar_chart</span>Usage</button>}
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
      {window.aya.isWeb !== true && (
        <MachinesStatus onManage={() => onOpenSettings("machines")} onOpenTerminal={onOpenMachineTerminal} />
      )}
      <button
        data-testid="sound-toggle"
        className="aya-statusbar-item aya-statusbar-button"
        type="button"
        aria-label={terminalSoundsEnabled ? "Mute terminal sounds" : "Unmute terminal sounds"}
        aria-pressed={terminalSoundsEnabled}
        title={
          terminalSoundsEnabled
            ? "Terminal sounds: on (click to mute)"
            : "Terminal sounds: off (click to unmute)"
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onTerminalSoundsEnabledChange(!terminalSoundsEnabled)}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          {terminalSoundsEnabled ? "volume_up" : "volume_off"}
        </span>
      </button>
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
      <div className="aya-statusbar-popover-host aya-mobile-status-actions" ref={mobileActionsRef}>
        <button
          type="button"
          className="aya-statusbar-item aya-statusbar-button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={showMobileActions}
          onClick={() => setShowMobileActions((open) => !open)}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>more_horiz</span>
          More
        </button>
        {showMobileActions && (
          <div className="aya-statusbar-popover aya-mobile-status-actions-menu" role="menu" aria-label="More actions">
            <button type="button" role="menuitem" onClick={() => { setShowMobileActions(false); onTerminalSoundsEnabledChange(!terminalSoundsEnabled); }}>{terminalSoundsEnabled ? "Mute terminal sounds" : "Unmute terminal sounds"}</button>
            <button type="button" role="menuitem" disabled={snippetsDisabled} onClick={() => { setShowMobileActions(false); onToggleSnippets(); }}>Saved snippets</button>
            <button type="button" role="menuitem" disabled={!project} onClick={() => { setShowMobileActions(false); onOpenTeams(); }}>Teams</button>
            <button type="button" role="menuitem" onClick={() => { setShowMobileActions(false); onOpenAttentionCenter(); }}>Activity</button>
          </div>
        )}
      </div>
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
      {git ? (
        <div className="aya-statusbar-popover-host" ref={dirtyRef}>
          <button
            className={`aya-statusbar-item aya-statusbar-button ${git.dirty > 0 ? "aya-statusbar-item--warn" : ""}`}
            type="button"
            title={git.dirty > 0 ? "Show changed files" : "Show changes and publishing actions"}
            style={git.dirty === 0 ? { color: "var(--status-active)" } : undefined}
            // Inline dropdown — keep terminal focus (same as the top-bar ones).
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleDirtyFiles}
          >
            <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
              {git.dirty > 0 ? "edit_note" : "check_circle"}
            </span>
            {git.dirty > 0 ? `${git.dirty} dirty` : "clean"}
          </button>
          {showDirtyFiles && (
            <div
              className={`aya-statusbar-popover aya-statusbar-popover--changes ${showDiff ? "aya-statusbar-popover--diff" : ""}`}
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
              <div className="aya-statusbar-popover-content">
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
              ) : (
                <>
                  {dirtyFiles.length === 0 ? <div className="aya-statusbar-popover-empty">No changed files.</div> : <div className="aya-dirty-file-list">
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
                          aria-label={`Select ${printable(file.path)}`}
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
                  </div>}
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
                    {commitNotice && <div className="aya-dirty-publish-notice" role="status">{commitNotice}</div>}
                    <button
                      className="aya-statusbar-popover-action aya-dirty-commit-button"
                      type="button"
                      disabled={committing || dirtySelectionDirectory !== gitDirectory || selectedDirtyPaths.length === 0 || !commitMessage.trim()}
                      onClick={() => void commitSelectedFiles()}
                    >
                      {committing ? "Committing..." : "Commit selected"}
                    </button>
                    <div className="aya-dirty-publish-actions">
                      <button type="button" className="aya-statusbar-popover-action" disabled={publishing || !publishStatus || Boolean(publishStatus.pushDisabledReason)} title={publishStatus?.pushDisabledReason || undefined} onClick={() => void pushBranch()}>
                        {publishing ? "Working..." : "Push branch"}
                      </button>
                      <button type="button" className="aya-statusbar-popover-action" disabled={publishing || !publishStatus || Boolean(publishStatus.pullRequestDisabledReason)} title={publishStatus?.pullRequestDisabledReason || undefined} onClick={() => void openPullRequest()}>
                        {pullRequestUrl ? "Open pull request" : "Create pull request"}
                      </button>
                    </div>
                    {publishStatus?.pushDisabledReason && <div className="aya-dirty-publish-hint">{publishStatus.pushDisabledReason}</div>}
                    {publishStatus?.pullRequestDisabledReason && publishStatus.pullRequestDisabledReason !== publishStatus.pushDisabledReason && <div className="aya-dirty-publish-hint">{publishStatus.pullRequestDisabledReason}</div>}
                    {publishError && <div className="aya-dirty-commit-error" role="alert">{publishError}</div>}
                    {ciNotice && <div className="aya-dirty-publish-notice" role="status">{ciNotice}</div>}
                    {pullRequestUrl && (
                      <section className="aya-ci-checks" aria-label="Pull request checks">
                        <div className="aya-ci-checks-heading">
                          <span>Pull request checks</span>
                        </div>
                        {ciChecksError && ciChecksError !== publishError && <div className="aya-ci-checks-error" role="alert"><span>{ciChecksError}</span><button type="button" className="aya-statusbar-popover-action" onClick={() => ciRetryRef.current?.()}>Retry</button></div>}
                        {ciActionError && <div className="aya-ci-checks-error" role="alert">{ciActionError}</div>}
                        {pullRequestUrl && <>
                        {ciChecks?.pullRequestState === "merged" || ciChecks?.pullRequestState === "closed" ? (
                          <div className="aya-dirty-publish-hint">This pull request is {ciChecks.pullRequestState}; check updates have stopped.</div>
                        ) : ciChecks?.checks.length ? (
                          <div className="aya-ci-check-list">
                            {ciChecks.checks.map((check, index) => (
                              <div className="aya-ci-check" key={`${check.url ?? check.name}-${index}`}>
                                <span className={`aya-ci-check-state aya-ci-check-state--${check.bucket}`}>{ciCheckLabel(check)}</span>
                                <span className="aya-ci-check-name">{check.name}</span>
                                {check.url && <button type="button" className="aya-statusbar-popover-action" aria-label={`Open ${check.name} log`} onClick={() => void window.aya.openUrl(check.url!)}>Open log</button>}
                                {check.bucket === "fail" && check.url && <button type="button" className="aya-statusbar-popover-action" aria-label={`Preview ${check.name} failure details`} disabled={ciSending || !ciTargetId || reviewTargets.length === 0} onClick={() => void previewCiCheck(check.url!)}>Preview message</button>}
                              </div>
                            ))}
                          </div>
                        ) : <div className="aya-dirty-publish-hint">{ciChecksError ? "" : ciChecks?.pullRequestState === "none" ? "No pull request for this branch yet." : "Waiting for checks..."}</div>}
                        {ciChecks?.checks.some((check) => check.bucket === "fail" && check.url) && reviewTargets.length === 0 && (
                          <div className="aya-dirty-publish-hint">Open an agent pane in this project before sending check details.</div>
                        )}
                        {ciChecks?.checks.some((check) => check.bucket === "fail" && check.url) && reviewTargets.length > 0 && (
                          <label className="aya-ci-target-label" htmlFor="aya-ci-target">Send failed checks to
                            <select id="aya-ci-target" value={ciTargetId ?? ""} disabled={ciSending} onChange={(event) => {
                              cancelCiActionRequest();
                              const targetId = event.currentTarget.value || null;
                              ciTargetIdRef.current = targetId;
                              ciPreviewRequestId.current += 1;
                              setCiTargetId(targetId);
                              setCiPreview(null);
                            }}>
                              {reviewTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                            </select>
                          </label>
                        )}
                        {selectedCiCheckUrl && ciPreview && (
                          <div className="aya-ci-preview">
                            <div className="aya-dirty-publish-hint">Will send to {reviewTargets.find((target) => target.id === ciTargetId)?.name ?? "selected pane"}</div>
                            <label htmlFor="aya-ci-prompt-preview">Exact message to send</label>
                            <textarea id="aya-ci-prompt-preview" readOnly value={ciPreview.prompt} rows={8} />
                            <button type="button" className="aya-statusbar-popover-action" disabled={ciSending} onClick={() => {
                              cancelCiActionRequest();
                              ciPreviewRequestId.current += 1;
                              setCiPreview(null);
                              setSelectedCiCheckUrl(null);
                            }}>Dismiss preview</button>
                            <button type="button" className="aya-statusbar-popover-action" disabled={ciSending || !ciTargetId} onClick={() => void sendCiCheck()}>{ciSending ? "Sending..." : "Send"}</button>
                          </div>
                        )}
                        {selectedCiCheckUrl && ciPreviewLoading && (
                          <div className="aya-ci-preview" role="status">
                            <span>Preparing the message...</span>
                            <button type="button" className="aya-statusbar-popover-action" onClick={() => {
                              cancelCiActionRequest();
                              ciPreviewRequestId.current += 1;
                              setSelectedCiCheckUrl(null);
                            }}>Cancel preview</button>
                          </div>
                        )}
                        </>}
                      </section>
                    )}
                  </div>
                </>
              )}
              </div>
            </div>
          )}
        </div>
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

/** Memoized: App re-renders on every poll tick / terminal status flip; with
 *  the derived props memoized in App (R1) and the handlers useCallback'd,
 *  the shallow compare lets the chrome skip those renders entirely. */
export const StatusBar = memo(StatusBarImpl);
