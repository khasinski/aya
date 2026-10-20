import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { mergeGitInfo, type GitInfo } from "../project-helpers";
import { GIT_STATUS_POLL_INTERVAL_MS } from "../ui-timing";
import { gitContextCwd } from "../worktree";
import type { GitHubLink, ProjectConfig, TerminalState, WorktreeStatus } from "../types";

interface GitStatusOptions {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  projectFallbacks: Record<string, string>;
  activeTerminal: TerminalState | null;
  activeTabId: string | null;
  projectsRef: RefObject<ProjectConfig[]>;
  activeProjectIdRef: RefObject<string | null>;
  findProject: (projects: ProjectConfig[], slug: string) => ProjectConfig | null;
  pollVisible: (refresh: () => void, intervalMs: number) => () => void;
  samePollPayload: <T>(prev: T, next: T) => boolean;
}

export function useGitStatus({
  projects,
  activeProjectId,
  projectFallbacks,
  activeTerminal,
  activeTabId,
  projectsRef,
  activeProjectIdRef,
  findProject,
  pollVisible,
  samePollPayload,
}: GitStatusOptions) {
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const [githubLinks, setGithubLinks] = useState<
    Record<string, GitHubLink | null>
  >({});
  // Worktrees of the active (local) project, with branch + dirty count. Polled
  // (not loaded once per project switch) because an agent asked to "work in a
  // worktree" creates one mid-session — it has to show up without a restart.
  // Feeds the status bar's checkout picker; the sidebar's worktree grouping and
  // launcher target additionally require the experimental flag.
  const [worktrees, setWorktrees] = useState<WorktreeStatus[]>([]);
  // Bumped after a create/remove so the poll effect re-fires immediately;
  // without it a freshly created worktree would wait out the poll interval.
  const [worktreeNudge, setWorktreeNudge] = useState(0);
  // Checkout the user PINNED in the status bar (slug -> path), overriding the
  // "follow the console" default. Session-only: a pin is a look-at-this-now
  // decision, not a project setting.
  const [pinnedCheckout, setPinnedCheckout] = useState<Record<string, string>>(
    {},
  );
  // Checkout root the ACTIVE terminal is really in: its process cwd (which a
  // `cd` moves) resolved to the enclosing git root. null until the first read,
  // or when it can't be determined — then the spawn cwd stands in.
  const [liveCheckout, setLiveCheckout] = useState<string | null>(null);
  // The active project's own checkout — where a terminal with no worktree
  // binding runs. null for remote projects (no local working tree).
  const activeProjectCheckout = useMemo(() => {
    if (!activeProjectId) return null;
    const project = findProject(projects, activeProjectId);
    if (!project || project.remote) return null;
    const base = projectFallbacks[project.slug] ?? project.directory;
    return gitContextCwd(base, activeTerminal?.cwd);
  }, [activeProjectId, projects, projectFallbacks, activeTerminal?.cwd, findProject]);

  // Follow the console: read the active terminal's REAL cwd (a `cd` — or an
  // agent that made itself a worktree and moved into it — leaves the spawn cwd
  // behind) and resolve it to the enclosing checkout root, since the cwd can be
  // a subdirectory. Active terminal only, on the git cadence: ~70ms on macOS
  // (lsof; there is no /proc), so this is not something to run per tab.
  const liveCwdRef = useRef<string | null>(null);
  useEffect(() => {
    liveCwdRef.current = null;
    setLiveCheckout(null);
    if (!activeTabId || !activeProjectCheckout) return;
    let cancelled = false;
    const refresh = () => {
      void window.aya.ptyCwd(activeTabId).then(async (cwd) => {
        if (cancelled || !cwd) return;
        // Same cwd as last tick — the resolved root can't have changed, so skip
        // the `git rev-parse`. Only a cd (or the first read) pays for it.
        if (cwd === liveCwdRef.current) return;
        const root = await window.aya.getGitRoot(cwd);
        if (cancelled) return;
        liveCwdRef.current = cwd;
        setLiveCheckout(root);
      });
    };
    const stop = pollVisible(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeTabId, activeProjectCheckout, pollVisible]);

  // The checkout the status bar's git surface describes, in priority order:
  // what the user pinned in the picker, else where the console actually is,
  // else the terminal's spawn cwd (a worktree binding or the project dir).
  // null = nothing to read (no project, or a remote one).
  const activeGitDirectory = useMemo(() => {
    if (!activeProjectCheckout) return null;
    const pinned = activeProjectId ? pinnedCheckout[activeProjectId] : null;
    return pinned ?? liveCheckout ?? activeProjectCheckout;
  }, [activeProjectCheckout, activeProjectId, pinnedCheckout, liveCheckout]);

  // Status-bar branch / dirty count goes stale once you `git checkout` in a
  // shell or commit something — there's no inotify watch, just a small poll
  // for the active checkout. ~50ms subprocess, 3s cadence; cancelled on
  // project / worktree-tab switch.
  useEffect(() => {
    if (!activeGitDirectory) return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      void window.aya.getGitInfo(activeGitDirectory).then((info) => {
        if (cancelled) return;
        setGit((g) => mergeGitInfo(g, activeGitDirectory, info));
      });
    };
    const stop = pollVisible(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeGitDirectory, pollVisible]);

  // Poll the active local project's worktrees (with branch + dirty count). It
  // used to load once per project switch, which meant a worktree an agent
  // created during the session stayed invisible until you switched away and
  // back. `git worktree list` is ~8ms and the per-worktree status calls only
  // run when there is more than one checkout to tell apart.
  useEffect(() => {
    if (!activeProjectCheckout) {
      setWorktrees([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void window.aya.getGitWorktreeStatus(activeProjectCheckout).then((list) => {
        if (cancelled) return;
        setWorktrees((prev) => (samePollPayload(prev, list) ? prev : list));
      });
    };
    const stop = pollVisible(refresh, GIT_STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeProjectCheckout, worktreeNudge, pollVisible, samePollPayload]);

  // Drop a pin whose worktree is gone (removed, or the project now points at a
  // different repo). Left in place it would aim the whole git surface at a dead
  // path, and with no branch to render there would be no chip left to click to
  // undo it. Only acts on a non-empty list, so a failed read doesn't unpin.
  useEffect(() => {
    if (!activeProjectId || worktrees.length === 0) return;
    const pinned = pinnedCheckout[activeProjectId];
    if (!pinned) return;
    // Keep the pin only while it still points at a live, branch-bearing
    // checkout. A worktree that was removed (now absent from the list) or went
    // prunable/bare (its gitdir is gone) resolves to branch null, which hides
    // the branch chip AND its picker — leaving no control to un-pin with.
    const match = worktrees.find((w) => w.path === pinned);
    if (match && !match.prunable && !match.bare) return;
    setPinnedCheckout((prev) => {
      if (!(activeProjectId in prev)) return prev;
      const next = { ...prev };
      delete next[activeProjectId];
      return next;
    });
  }, [activeProjectId, worktrees, pinnedCheckout]);

  const createWorktreesForProject = useCallback(async (request: { directory: string; slug: string; count: number; base: string }) => {
    const project = projectsRef.current.find((p) => p.slug === activeProjectId);
    if (!project || project.remote || project.directory !== request.directory) return { created: [], errors: ["Worktrees are available for local projects only."] };
    const result = await window.aya.createWorktreeBatch(request);
    if (result.created.length) setWorktreeNudge((n) => n + 1);
    return result;
  }, [activeProjectId, projectsRef]);

  const removeWorktreeForProject = useCallback(async (request: { directory: string; path: string; base: string; deleteBranch: boolean }) => {
    const project = projectsRef.current.find((p) => p.slug === activeProjectId);
    if (!project || project.remote || project.directory !== request.directory) return { ok: false as const, error: "Worktrees are available for local projects only." };
    const result = await window.aya.removeWorktreeAndBranch(request);
    if (result.ok) setWorktreeNudge((n) => n + 1);
    return result;
  }, [activeProjectId, projectsRef]);

  // Status-bar checkout picker: pin a worktree, or go back to following the
  // console. Pinning by path (not index) so a worktree added or removed between
  // renders can't silently repoint the pin at a different checkout.
  const pinCheckout = useCallback(
    (path: string | null) => {
      const slug = activeProjectIdRef.current;
      if (!slug) return;
      setPinnedCheckout((prev) => {
        if (!path) {
          if (!(slug in prev)) return prev;
          const next = { ...prev };
          delete next[slug];
          return next;
        }
        return prev[slug] === path ? prev : { ...prev, [slug]: path };
      });
    },
    [activeProjectIdRef],
  );
  // Git surface (branch, dirty, diff, GitHub link) reads the active terminal's
  // checkout — see activeGitDirectory — so all of it is keyed by directory.
  const activeGit = activeGitDirectory ? (git[activeGitDirectory] ?? null) : null;
  const activeGithubLink = activeGitDirectory
    ? (githubLinks[activeGitDirectory] ?? null)
    : null;
  const activeBranch = activeGit?.branch ?? null;
  return {
    setGit,
    worktrees,
    pinnedCheckout,
    activeGitDirectory,
    activeGit,
    activeGithubLink,
    activeBranch,
    setGithubLinks,
    createWorktreesForProject,
    removeWorktreeForProject,
    pinCheckout,
  };
}

interface GitHubLinkEffectOptions {
  showGitHubLink: boolean;
  activeGitDirectory: string | null;
  activeBranch: string | null;
  setGithubLinks: Dispatch<SetStateAction<Record<string, GitHubLink | null>>>;
}

// Called at the original GitHub effect site to preserve App's effect order.
export function useGitHubLinkEffect({
  showGitHubLink,
  activeGitDirectory,
  activeBranch,
  setGithubLinks,
}: GitHubLinkEffectOptions) {
  // Resolve the PR/branch link only when the active checkout or its branch
  // changes — `gh pr view` hits the GitHub API, so we deliberately keep it off
  // the 3s git poll. Local repos only; remote projects have no working tree.
  useEffect(() => {
    if (!showGitHubLink || !activeGitDirectory) return;
    let cancelled = false;
    void window.aya.getGitHubLink(activeGitDirectory).then((link) => {
      if (cancelled) return;
      setGithubLinks((prev) => ({ ...prev, [activeGitDirectory]: link }));
    });
    return () => {
      cancelled = true;
    };
  }, [showGitHubLink, activeGitDirectory, activeBranch, setGithubLinks]);
}
