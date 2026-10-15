import { useCallback, useEffect, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { clearedTerminalStatus } from "../pty-event-reducer";
import { forgetSpawn, wasSpawned } from "../spawnSession";
import { defaultTabName, findProject, remoteTerminalCommand } from "../project-helpers";
import { projectBaseCwd, tabFromTerminal } from "../worktree";
import {
  assignTerminal,
  compactTree,
  normalizeTreeForTabs,
  projectSplitTree,
  resolveActiveLeafId,
} from "../split-tree";
import { PRESET_ID_SHELL } from "../preset-ids";
import { nextActiveTerminalId, projectLaunchCwd, shellPresetForTab } from "../terminal-actions";
import { uuid } from "../uuid";
import { getPreset, type Preset, type ProjectConfig, type ProjectEvent, type TerminalState, type WorkingTab } from "../types";

interface TerminalActionsOptions {
  projectFallbacks: Record<string, string>;
  activeProjectId: string | null;
  activeTabByProject: Record<string, string | null>;
  activeLeafByProject: Record<string, string>;
  activeProjectIdRef: RefObject<string | null>;
  activeTabByProjectRef: RefObject<Record<string, string | null>>;
  projectsRef: RefObject<ProjectConfig[]>;
  terminalsRef: RefObject<Record<string, TerminalState>>;
  presetsRef: RefObject<Preset[]>;
  remotePresetsByProjectRef: RefObject<Record<string, Preset[]>>;
  splitEnabledRef: RefObject<boolean>;
  lastActivityRef: RefObject<Record<string, number>>;
  setTerminals: Dispatch<SetStateAction<Record<string, TerminalState>>>;
  setAllProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setProjects: Dispatch<SetStateAction<ProjectConfig[]>>;
  setActiveTabByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
  setSingleViewByProject: Dispatch<SetStateAction<Record<string, string | null>>>;
  setCloseFocusHold: Dispatch<SetStateAction<{ slug: string; terminalId: string } | null>>;
  appendProjectEvent: (event: Omit<ProjectEvent, "id" | "createdAt"> & { createdAt?: number }) => void;
  persistProject: (slug: string, nextTerminals: Record<string, TerminalState>) => void;
}

export function useTerminalActions({
  projectFallbacks,
  activeProjectId,
  activeTabByProject,
  activeLeafByProject,
  activeProjectIdRef,
  activeTabByProjectRef,
  projectsRef,
  terminalsRef,
  presetsRef,
  remotePresetsByProjectRef,
  splitEnabledRef,
  lastActivityRef,
  setTerminals,
  setAllProjects,
  setProjects,
  setActiveTabByProject,
  setSingleViewByProject,
  setCloseFocusHold,
  appendProjectEvent,
  persistProject,
}: TerminalActionsOptions) {
  /** Resolve the effective cwd for a project at terminal-launch time. Honors
   *  any session fallback (e.g. "Use home for now"). */
  const effectiveCwd = useCallback(
    (project: ProjectConfig): string => {
      return projectLaunchCwd(project, projectFallbacks);
    },
    [projectFallbacks],
  );

  const launchTerminal = useCallback(
    (preset: Preset, cwd?: string, sshTarget?: string) => {
      const slug = activeProjectIdRef.current;
      if (!slug) return;
      const project = findProject(projectsRef.current, slug);
      if (!project) return;
      const id = uuid();
      const command = remoteTerminalCommand(project, preset);
      // Default the new tab's display name to the preset's current name (not
      // its id, which stays the same when the user renames a preset).
      const term: TerminalState = {
        id,
        projectSlug: slug,
        presetId: preset.id,
        name: sshTarget ? `ssh ${sshTarget}` : defaultTabName(preset),
        cwd:
          cwd ??
          (project.remote ? project.remote.directory : effectiveCwd(project)),
        status: "running",
        bell: false,
        exitCode: null,
        ...(sshTarget ? { sshTarget } : {}),
      };
      setTerminals((prev) => {
        const next = { ...prev, [id]: term };
        const tabs: WorkingTab[] = Object.values(next)
          .filter((t) => t.projectSlug === slug)
          .map((t) => tabFromTerminal(t, projectBaseCwd(project)));
        // In the projects-left layout splits are disabled, so leave the saved
        // tree untouched (don't claim a pane for the new terminal, and don't
        // clear it) - it should come back unchanged in the classic layout.
        const existingTree = projectSplitTree(project);
        const currentTree =
          splitEnabledRef.current && existingTree
            ? normalizeTreeForTabs(
                existingTree,
                new Set(tabs.map((tab) => tab.id)),
                activeTabByProject[slug] ?? project.tabs[0]?.id ?? null,
                uuid(),
              )
            : null;
        const splitTree = currentTree
          ? compactTree(
              assignTerminal(
                currentTree,
                resolveActiveLeafId(
                  currentTree,
                  activeLeafByProject[slug],
                  activeTabByProject[slug] ?? null,
                ),
                id,
              ),
            )
          : undefined;
        const updated: ProjectConfig = {
          ...project,
          tabs,
          ...(splitEnabledRef.current
            ? { splitLayout: undefined, ...(splitTree ? { splitTree } : { splitTree: undefined }) }
            : {}),
        };
        setAllProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
        setProjects((ps) => ps.map((p) => (p.slug === slug ? updated : p)));
        void window.aya.updateProject(updated);
        return next;
      });
      setActiveTabByProject((prev) => ({ ...prev, [slug]: id }));
      setSingleViewByProject((prev) => ({
        ...prev,
        [slug]: projectSplitTree(project) && prev[slug] ? id : null,
      }));
      appendProjectEvent({
        projectSlug: slug,
        terminalId: id,
        level: "active",
        title: `${term.name} started`,
        detail: command,
      });
    },
    [activeTabByProject, activeLeafByProject, appendProjectEvent, effectiveCwd, activeProjectIdRef, projectsRef, splitEnabledRef, setTerminals, setAllProjects, setProjects, setActiveTabByProject, setSingleViewByProject],
  );

  // aya team open / Apply panes: main picked the ids and assigns the roles
  // once the project is saved with the new tabs.
  useEffect(
    () =>
      window.aya.onTeamOpenPanes(({ requestId, projectSlug, panes }) => {
        const open = async () => {
          const project = findProject(projectsRef.current, projectSlug);
          if (!project) throw new Error(`project ${projectSlug} is not open in this window`);
          const added: Record<string, TerminalState> = {};
          for (const pane of panes) {
            if (!presetsRef.current.some((p) => p.id === pane.presetId)) throw new Error(`no preset "${pane.presetId}" in this window`);
            added[pane.id] = {
              id: pane.id,
              projectSlug,
              presetId: pane.presetId,
              name: pane.name,
              cwd: effectiveCwd(project),
              status: "running",
              bell: false,
              exitCode: null,
              ...(pane.teamLaunch ? { teamLaunch: true } : {}),
            };
          }
          // Refs first, as closeTerminal does: a save racing this one must see the new tabs.
          const next = { ...terminalsRef.current, ...added };
          terminalsRef.current = next;
          const tabs = Object.values(next)
            .filter((t) => t.projectSlug === projectSlug)
            .map((t) => tabFromTerminal(t, projectBaseCwd(project)));
          const updated: ProjectConfig = { ...project, tabs };
          setTerminals((prev) => ({ ...prev, ...added }));
          setAllProjects((ps) => ps.map((p) => (p.slug === projectSlug ? updated : p)));
          setProjects((ps) => ps.map((p) => (p.slug === projectSlug ? updated : p)));
          try {
            await window.aya.updateProject(updated);
          } catch (err) {
            // An unsaved tab would stay on screen with a running agent that main never assigns.
            const kept = { ...terminalsRef.current };
            for (const id of Object.keys(added)) delete kept[id];
            terminalsRef.current = kept;
            setTerminals((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !(id in added))));
            setAllProjects((ps) => ps.map((p) => (p.slug === projectSlug ? project : p)));
            setProjects((ps) => ps.map((p) => (p.slug === projectSlug ? project : p)));
            for (const id of Object.keys(added)) void window.aya.ptyKill(id);
            throw err;
          }
          for (const pane of panes) {
            appendProjectEvent({ projectSlug, terminalId: pane.id, level: "active", title: `${pane.name} started` });
          }
        };
        void open().then(
          () => window.aya.teamPanesOpened(requestId, null),
          (err: unknown) => window.aya.teamPanesOpened(requestId, err instanceof Error ? err.message : String(err)),
        );
      }),
    [appendProjectEvent, effectiveCwd, projectsRef, presetsRef, terminalsRef, setTerminals, setAllProjects, setProjects],
  );

  const closeTerminal = useCallback(
    (id: string) => {
      const t = terminalsRef.current[id];
      if (!t) return;
    // A closed tab plays no team role; a restart keeps it (same tab).
    void window.aya.teamReleasePane(t.projectSlug, id).catch(() => {});
    // Drop the confirmed-session marker so the id doesn't linger (and can't be
    // mistaken for a re-mount if the id were ever reused).
    forgetSpawn(id);
    // Drop the restart-trigger counter too - entries are tiny, but a
    // long-lived session cycling many tabs would otherwise retain one per
    // closed id forever (#94).
    setRestartTriggers((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    void window.aya.ptyKill(id);
    appendProjectEvent({
      projectSlug: t.projectSlug,
      terminalId: t.id,
      level: "info",
      title: `${t.name} closed`,
    });
    // Advance the refs now instead of waiting for the re-render. Closes can
    // arrive back-to-back - two quick Cmd+W, a script driving the control
    // socket - and the next one resolves "the active tab" through these refs.
    // While they still named the tab we just closed, that second close looked
    // up a terminal that was already gone and silently did nothing.
    const nextTerminals = { ...terminalsRef.current };
    delete nextTerminals[id];
    terminalsRef.current = nextTerminals;
    if (activeTabByProjectRef.current[t.projectSlug] === id) {
      const nextActive = nextActiveTerminalId(nextTerminals, t.projectSlug);
      activeTabByProjectRef.current = {
        ...activeTabByProjectRef.current,
        [t.projectSlug]: nextActive,
      };
      if (nextActive && activeProjectIdRef.current === t.projectSlug) {
        setCloseFocusHold({ slug: t.projectSlug, terminalId: nextActive });
      }
      setActiveTabByProject((p) =>
        p[t.projectSlug] === id ? { ...p, [t.projectSlug]: nextActive } : p,
      );
    }
    setTerminals((prev) => {
        const next = { ...prev };
        delete next[id];
        persistProject(t.projectSlug, next);
        return next;
      });
    },
    [appendProjectEvent, persistProject, terminalsRef, activeTabByProjectRef, activeProjectIdRef, setCloseFocusHold, setActiveTabByProject, setTerminals],
  );

  // Drop a terminal's agent status overlay once the user attends to it (#34,
  // Part 1). The overlay is an attention signal for terminals you are NOT
  // looking at, so the act of focusing the terminal IS the acknowledgement -
  // there is deliberately no separate "dismiss" control. Same
  // fall-back-to-PTY-truth as the control-socket `clear`; a real exit/spawn
  // error has no overlay and stays untouched. Returns `prev` when there is
  // nothing to clear so React can skip the re-render. The project-tab badge is
  // a pure aggregate over its terminals, so it keeps glowing until the last
  // flagged terminal is visited - no separate project-level clear needed.
  const clearTerminalStatus = useCallback((id: string) => {
    setTerminals((prev) => {
      const t = prev[id];
      if (!t || !t.externalStatus) return prev;
      return { ...prev, [id]: clearedTerminalStatus(t) };
    });
  }, [setTerminals]);

  // Switching to a terminal (sidebar click, keyboard tab-switch, split-pane
  // focus) acknowledges its overlay. Keyed on the active-tab map, so it fires
  // on the transition TO a terminal; clearTerminalStatus no-ops when there is
  // no overlay. Does not depend on `terminals`, so clearing can't re-trigger it.
  useEffect(() => {
    const id = activeProjectId ? activeTabByProject[activeProjectId] : null;
    if (id) clearTerminalStatus(id);
  }, [activeProjectId, activeTabByProject, clearTerminalStatus]);

  // Restart the detached PTY host (#28). This necessarily kills every running
  // terminal process - their PTYs are children of the host - so we mark all
  // terminals as exited rather than auto-respawning (maintainer decision:
  // leave tabs stopped; the user restarts each with Shift+Enter). Used by both
  // the stale-host banner and the Settings action.
  const restartPtyHost = useCallback(async (): Promise<string | null> => {
    try {
      await window.aya.restartPtyHost();
    } catch (err) {
      // Restart failed or did not finish (the old host still runs, or the user cancelled). The panes are left as
      // they are, the red dot on Restart Aya stays, and Settings shows why.
      const reason = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(err);
      // Saying no to the confirmation is not a failure to report.
      return reason === "restart cancelled" ? null : reason;
    }
    setTerminals((prev) => {
      const next: typeof prev = {};
      for (const [id, t] of Object.entries(prev)) {
        // `stopped` (not a fake exitCode 0) marks the PTY as killed-by-restart:
        // shows idle + restartable via Shift+Enter, without masquerading as a
        // clean "done" finish in the project badges or event log.
        next[id] = { ...t, status: "idle", stopped: true, bell: false };
      }
      return next;
    });
    return null;
  }, [setTerminals]);

  const renameTerminal = useCallback(
    (id: string, name: string) => {
      setTerminals((prev) => {
        const t = prev[id];
        if (!t) return prev;
        const next = { ...prev, [id]: { ...t, name } };
        persistProject(t.projectSlug, next);
        return next;
      });
    },
    [persistProject, setTerminals],
  );

  /** Called by TerminalView when the user presses Shift+Enter in a
   *  cleanly-exited terminal. Clears the exit state so the PTY event router
   *  can resume updating status when the new PTY emits data. */
  const restartTerminal = useCallback((id: string) => {
    const terminal = terminalsRef.current[id];
    // Continuity across in-session respawns: if this tab already ran a session
    // (confirmed live output - wasSpawned, #67), the respawn must carry the
    // agent resume arg exactly like a boot-restored tab, or a launcher-opened
    // claude/codex tab comes back as a brand-new EMPTY session and the
    // conversation is lost. Flipping `restored` is the one gate
    // terminalCommand already reads. A deliberately fresh session = close the
    // tab and open a new one from the launcher.
    //
    // spawnFailure veto: the host paints the failure banner as a synthetic
    // `data` event (pty.ts reportSpawnFailure) which can mark wasSpawned
    // before the spawn-failed state lands in the ref the router guards on -
    // and a tab whose spawn FAILED has no session to resume. Without the
    // veto, the banner's Restart would append --continue and resume an
    // unrelated conversation from the same cwd. A tab that had a REAL
    // session before a failed respawn keeps continuity through the sticky
    // `restored` flag flipped by that earlier restart.
    const hadSession = wasSpawned(id) && !terminal?.spawnFailure;
    // Same marker hygiene as forceRestartTerminal (after hadSession is read):
    // an explicit restart means the NEXT mount of this id must plain-spawn.
    // Leaving the no-session marker set would let a remount that races the
    // trigger spawn attach-probe again and re-stick `stopped` onto a live
    // process; the host's in-flight/ptys guards make a double plain spawn
    // safe, so forgetting is the strictly better side of that race. The
    // unconditional forget also subsumes the #87 veto fix: a poisoned
    // wasSpawned marker from a failed spawn's banner is dropped here too,
    // so it can never latch `restored` on a later restart.
    forgetSpawn(id);
    setTerminals((prev) => {
      const t = prev[id];
      if (!t) return prev;
      return {
        ...prev,
        [id]: {
          ...t,
          exitCode: null,
          status: "running",
          bell: false,
          spawnFailure: undefined,
          stopped: undefined,
          restored: t.restored || hadSession,
        },
      };
    });
    // Spawn via the restartTrigger effect in TerminalView - it fires AFTER
    // this state batch re-renders, so the command it reads already carries the
    // resume arg from the restored flip above. Spawning directly in the
    // caller (the old way) raced the re-render and lost the -c.
    setRestartTriggers((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    // Also clear the activity timestamp so the dot doesn't claim "recently
    // active" until the new PTY actually writes something.
    delete lastActivityRef.current[id];
    if (terminal) {
      appendProjectEvent({
        projectSlug: terminal.projectSlug,
        terminalId: terminal.id,
        level: "active",
        title: `${terminal.name} restarted`,
      });
    }
  }, [appendProjectEvent, lastActivityRef, terminalsRef, setTerminals]);

  // Per-terminal counter - bumped each time we forcibly restart (right-click
  // -> Restart). TerminalView watches the prop and triggers a fresh ptySpawn
  // on change, reusing the existing xterm instance + scrollback.
  const [restartTriggers, setRestartTriggers] = useState<Record<string, number>>(
    {},
  );

  /** Right-click -> "Restart" handler. Kills the PTY if it can still be
   *  alive (see the maybeAlive gate) and asks TerminalView to spawn a
   *  fresh one. */
  const forceRestartTerminal = useCallback(async (id: string) => {
    const t = terminalsRef.current[id];
    if (!t) return;
    // Read the had-a-session marker BEFORE the kill and forgetSpawn below wipe
    // it - the respawned agent tab must resume its conversation (see
    // restartTerminal for the rationale, including the spawnFailure veto).
    const hadSession = wasSpawned(id) && !t.spawnFailure;
    // Kill only a possibly-live PTY. For an already-dead tab (exited - which
    // includes spawn failures, they emit a synthetic exit - or stopped by a
    // host restart) the host map has no entry, so killPty would arm its
    // pending-kill marker (the closed-tab race guard) and that marker would
    // swallow the respawn the trigger below requests - a silent "Restart did
    // nothing" for up to the marker's TTL. A death the renderer has not seen
    // yet (exit event still in flight) can still hit that window; the gate
    // covers every state the user can actually observe when clicking.
    const maybeAlive = t.exitCode === null && !t.stopped;
    // Asked first when the restart would stop work in the pane: a turn, a command, background tasks (#219). A
    // question that cannot be asked stops the restart: going ahead could end work nobody agreed to stop.
    if (maybeAlive) {
      const agreed = await window.aya.confirmPaneRestart(id).catch((err: unknown) => {
        console.warn("[aya] could not ask before restarting the pane; it keeps running", err);
        return false;
      });
      if (!agreed) return;
    }
    if (maybeAlive) {
      // Await the kill so the main-side ptys map is empty by the time the
      // new spawn IPC arrives - otherwise spawnPty treats it as a re-mount
      // and replays the old buffer instead of starting fresh.
      try {
        await window.aya.ptyKill(id);
      } catch {
        /* ignore - best effort */
      }
    }
    // Forget the confirmed-session marker AFTER the kill: a still-alive process
    // can emit output between the request and the kill landing, which would
    // re-mark the id; clearing it last (once the PTY is dead, no more output)
    // ensures an UNMOUNTED tab's next mount spawns fresh instead of attaching-
    // only to a killed PTY (which would no-session it and stick it as stopped).
    forgetSpawn(id);
    setTerminals((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      return {
        ...prev,
        [id]: {
          ...cur,
          exitCode: null,
          status: "running",
          bell: false,
          spawnFailure: undefined,
          stopped: undefined,
          restored: cur.restored || hadSession,
        },
      };
    });
    delete lastActivityRef.current[id];
    appendProjectEvent({
      projectSlug: t.projectSlug,
      terminalId: t.id,
      level: "active",
      title: `${t.name} restarted`,
    });
    setRestartTriggers((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, [appendProjectEvent, lastActivityRef, terminalsRef, setTerminals]);

  /** Open a shell terminal in the active project. Used by Cmd/Ctrl+T. Falls
   *  back to BUILTIN_SHELL if the user has deleted their shell preset so the
   *  shortcut always works. */
  const openShellTab = useCallback(() => {
    const slug = activeProjectIdRef.current;
    if (!slug) return;
    const project = projectsRef.current.find((p) => p.slug === slug);
    const sourcePresets =
      project?.remote
        ? (remotePresetsByProjectRef.current[slug] ?? presetsRef.current)
        : presetsRef.current;
    const shellPreset = shellPresetForTab(sourcePresets);
    launchTerminal(shellPreset);
  }, [launchTerminal, activeProjectIdRef, projectsRef, remotePresetsByProjectRef, presetsRef]);

  /** A tab on one of the user's machines, from the machines popover: `ssh -- <target>` in the active project. */
  const openMachineTerminal = useCallback(
    (sshTarget: string) => launchTerminal(getPreset(presetsRef.current, PRESET_ID_SHELL), undefined, sshTarget),
    [launchTerminal, presetsRef],
  );

  return {
    launchTerminal,
    closeTerminal,
    restartPtyHost,
    renameTerminal,
    restartTerminal,
    restartTriggers,
    forceRestartTerminal,
    openShellTab,
    openMachineTerminal,
  };
}
