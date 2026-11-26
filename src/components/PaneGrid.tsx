import { memo,useCallback,useRef,type RefObject } from "react";
import { paneCanSwitchMode,paneMode } from "../pane-mode";
import { beginGuiPaneRecovery, guiRendererRecoveryInProgress } from '../gui-renderer-recovery';
import type { GuiPaneStatus } from "../gui-status";
import { emptyProjectPaneTitle,paneStyleFromRect } from "../pane-grid";
import { PRESET_ID_BOARD } from "../preset-ids";
import { findProject,terminalSpawn } from "../project-helpers";
import type { SettingsTab } from "../settings-tabs";
import type { DividerRect,LeafRect } from "../split-tree";
import type { MacOptionKeyMode } from "../terminal-option-key";
import {
	getPreset,
	type BoardSnapshot,
	type Preset,
	type ProjectConfig,
	type Snippet,
	type TerminalState,
	type Theme,
	type ThemeColors,
} from "../types";
import { projectBaseCwd } from "../worktree";
import { ConversationView } from "./ConversationView";
import { PaneModeVeil } from "./PaneModeVeil";
import { usePaneModeTransitions } from "../pane-mode-transition";
import { KanbanView } from "./KanbanView";
import { LocalErrorBoundary } from './LocalErrorBoundary';
import { SplitResizeHandle } from "./SplitResizeHandle";
import { TerminalView } from "./TerminalView";

interface Props {
  isSplit: boolean;
  paneRects: LeafRect[];
  terminals: Record<string, TerminalState>;
  activeLeafId: string | null;
  activeProjectId: string | null;
  setActiveSplitCell: (slug: string, leafId: string) => void;
  unsplitLeaf?: (slug: string, leafId: string) => void;
  assignableProjectTerminals: TerminalState[];
  activePresets: Preset[];
  assignTerminalToSplitCell: (terminalId: string, leafId: string) => void;
  themes: Theme[];
  skinThemeColors: ThemeColors | null;
  activeThemeColors: ThemeColors;
  activeProject: ProjectConfig | null;
  resumePanes: Array<{ id: string; preset: Preset; cwd: string }>;
  homeDir: string;
  snippets: Snippet[];
  snippetDrawerTerminalId: string | null;
  setSnippetDrawerTerminalId: (terminalId: string | null) => void;
  lastActivityRef: RefObject<Record<string, number>>;
  effectiveTerminalFontFamily: string | undefined;
  fontSize: number;
  findInPaneFor: string | null;
  closeFindPane: () => void;
  harnessSearchEnabled: boolean;
  /** Settings > Kanban > Move backlog to shelf: the Backlog column shows in the shelf, not on the board. */
  kanbanBacklogOnShelf?: boolean;
  openSettings: (tab?: SettingsTab) => void;
  closeProject: (slug: string) => void;
  restartTerminal: (terminalId: string) => void;
  onSpawnFailure: (terminalId: string) => void;
  restartTriggers: Record<string, number>;
  /** A Conversation GUI pane's status, for the status rail, attention centre and sidebar. */
  onReportPaneStatus?: (terminalId: string, status: GuiPaneStatus) => void;
  macOptionKeyMode: MacOptionKeyMode;
  anyOverlayOpen: boolean;
  closeFocusHold: { slug: string; terminalId: string } | null;
  hiddenTerminals: TerminalState[];
  projects: ProjectConfig[];
  remotePresetsByProject: Record<string, Preset[]>;
  presets: Preset[];
  ignoreSnippetsOpenChange: (open: boolean) => void;
  paneDividers: DividerRect[];
  /** "Stacked" layout: where the visible terminal draws its header (the top bar); null keeps it in the pane. */
  headerSlot?: HTMLElement | null;
  resizeSplit: (slug: string, splitId: string, ratio: number) => void;
  projectTerminals: TerminalState[];
  onStartCardInNewPane?: (preset: Preset, cardId: string, projectSlug: string, cwd?: string) => Promise<BoardSnapshot>;
  onCreateWorktrees?: (req: { directory: string; slug: string; count: number; base: string }) => Promise<{ created: { path: string; branch: string }[]; errors: string[] }>;
  onFocusTerminal?: (terminalId: string) => void;
  onSplitBesideTerminal?: (anchorId: string, targetId: string) => void;
  /** Terminal ⇄ Conversation (usePaneModeSwitch). */
  onSwitchToConversation?: (terminalId: string, force?: boolean) => Promise<string | null>;
  onSwitchToTerminal?: (terminalId: string, sessionId?: string) => void;
}

export const PaneGrid = memo(function PaneGrid({
  isSplit,
  paneRects,
  terminals,
  activeLeafId,
  activeProjectId,
  setActiveSplitCell,
  unsplitLeaf,
  assignableProjectTerminals,
  activePresets,
  assignTerminalToSplitCell,
  themes,
  skinThemeColors,
  activeThemeColors,
  activeProject,
  resumePanes,
  homeDir,
  snippets,
  snippetDrawerTerminalId,
  setSnippetDrawerTerminalId,
  lastActivityRef,
  effectiveTerminalFontFamily,
  fontSize,
  findInPaneFor,
  closeFindPane,
  harnessSearchEnabled,
  kanbanBacklogOnShelf = false,
  openSettings,
  closeProject,
  restartTerminal,
  onSpawnFailure,
  restartTriggers,
  onReportPaneStatus,
  macOptionKeyMode,
  anyOverlayOpen,
  closeFocusHold,
  hiddenTerminals,
  projects,
  remotePresetsByProject,
  presets,
  ignoreSnippetsOpenChange,
  paneDividers,
  headerSlot = null,
  resizeSplit,
  projectTerminals,
  onStartCardInNewPane,
  onCreateWorktrees,
  onFocusTerminal,
  onSplitBesideTerminal,
  onSwitchToConversation,
  onSwitchToTerminal,
}: Props) {
  const modeTransitions = usePaneModeTransitions();
  // A stable lookup, so a GUI pane (memoised) does not re-render whenever another terminal's status changes.
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const listSiblingTerminals = useCallback((self: { id: string; projectSlug: string }) =>
    Object.values(terminalsRef.current)
      .filter((t) => t.projectSlug === self.projectSlug && t.id !== self.id && t.presetId !== PRESET_ID_BOARD)
      .map((t) => ({ id: t.id, name: t.name })), []);
  return (
    <div className={`aya-panes ${isSplit ? "aya-panes--split" : ""}`}>
      {paneRects.map(({ leafId, terminalId, rect }) => {
        const terminal = terminalId ? terminals[terminalId] : null;
        // Panes are positioned from the tree's rectangles rather than
        // nested to match it: nesting would move each TerminalView in
        // the React tree on every reshape and remount the terminal.
        const paneStyle = paneStyleFromRect(isSplit, rect);
        const errorPaneClass = `aya-pane${isSplit && activeLeafId === leafId ? " aya-pane--active-split" : ""}`;
        const activatePane = () => { if (activeProjectId) setActiveSplitCell(activeProjectId, leafId); };
        if (!terminal) {
          return (
            <div
              key={`empty-${leafId}`}
              style={paneStyle}
              className={`aya-pane aya-pane-empty ${
                activeLeafId === leafId ? "aya-pane-empty--active" : ""
              }`}
              onClick={() => {
                if (!activeProjectId) return;
                setActiveSplitCell(activeProjectId, leafId);
              }}
            >
              <div className="aya-pane-header">
                <span className="aya-pane-header-title">Empty pane</span>
                {isSplit && activeProjectId && unsplitLeaf && (
                  <div className="aya-pane-header-meta">
                    <button
                      type="button"
                      className="aya-pane-close"
                      aria-label="Close pane"
                      title="Close pane"
                      onClick={(event) => {
                        event.stopPropagation();
                        unsplitLeaf(activeProjectId, leafId);
                      }}
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "var(--aya-pane-subtle)",
                        cursor: "pointer",
                        fontSize: 15,
                        lineHeight: 1,
                        padding: "0 2px",
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              <div className="aya-pane-empty-body">
                {assignableProjectTerminals.length === 0 ? (
                  <div className="aya-pane-empty-hint">No hidden terminals</div>
                ) : (
                  <div className="aya-pane-empty-list">
                    {assignableProjectTerminals.map((candidate) => {
                      const preset = getPreset(activePresets, candidate.presetId);
                      return (
                        <button
                          key={candidate.id}
                          className="aya-pane-empty-terminal"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            assignTerminalToSplitCell(candidate.id, leafId);
                          }}
                        >
                          <span
                            className="aya-sidebar-icon"
                            style={preset.color ? { color: preset.color } : undefined}
                          >
                            {preset.icon}
                          </span>
                          <span>{candidate.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        }
        const preset = getPreset(activePresets, terminal.presetId);
        // Per-preset theme override (set in Settings) wins over the
        // global active theme. Missing override → fall back to the
        // default the user picked. Missing theme entirely → fallback.
        const overrideTheme = preset.themeId
          ? themes.find((th) => th.id === preset.themeId)
          : null;
        const colorsForTerminal: ThemeColors =
          overrideTheme?.colors ?? skinThemeColors ?? activeThemeColors;
        if (terminal.presetId === PRESET_ID_BOARD) {
          return (
            <LocalErrorBoundary key={terminal.id} label="Board" className={errorPaneClass} onActivate={activatePane} style={paneStyle}><KanbanView
              terminal={terminal}
              backlogOnShelf={kanbanBacklogOnShelf}
              paneStyle={paneStyle}
              isActivePane={isSplit && activeLeafId === leafId}
              onActivatePane={() =>
                activeProjectId && setActiveSplitCell(activeProjectId, leafId)
              }
              listSiblingTerminals={listSiblingTerminals}
              siblingTerminals={projectTerminals.filter(
                (t) => t.id !== terminal.id && t.presetId !== PRESET_ID_BOARD,
              )}
              presets={activePresets}
              projectDir={
                activeProject && !activeProject.remote
                  ? projectBaseCwd(activeProject)
                  : undefined
              }
              onStartCardInNewPane={onStartCardInNewPane}
              onCreateWorktrees={onCreateWorktrees}
              onFocusTerminal={onFocusTerminal}
              onSplitRight={
                onSplitBesideTerminal
                  ? (targetId) => onSplitBesideTerminal(terminal.id, targetId)
                  : undefined
              }
              headerSlot={headerSlot}
            /></LocalErrorBoundary>
          );
        }
        return paneMode(preset, terminal, !!activeProject?.remote) === "gui" ? null : (
          <LocalErrorBoundary key={terminal.id} label="Terminal" className={errorPaneClass} onActivate={activatePane} style={paneStyle}><TerminalView
            paneStyle={paneStyle}
            terminal={terminal}
            preset={preset}
            {...terminalSpawn(activeProject, preset, terminal, resumePanes, homeDir)}
            snippets={snippets}
            snippetsOpen={snippetDrawerTerminalId === terminal.id}
            onSnippetsOpenChange={(open) =>
              setSnippetDrawerTerminalId(open ? terminal.id : null)
            }
            isVisible
            headerSlot={headerSlot}
            cwd={activeProject?.remote ? homeDir : terminal.cwd}
            lastActivity={lastActivityRef.current[terminal.id]}
            fontFamily={effectiveTerminalFontFamily}
            fontSize={fontSize}
            themeColors={colorsForTerminal}
            findOpen={findInPaneFor === terminal.id}
            onCloseFind={closeFindPane}
            historySearchEnabled={
              harnessSearchEnabled && !activeProject?.remote
            }
            onOpenSettings={openSettings}
            onCloseProject={closeProject}
            onRequestRestart={() => restartTerminal(terminal.id)}
            onSpawnFailure={onSpawnFailure}
            restartTrigger={restartTriggers[terminal.id] ?? 0}
            macOptionKeyMode={macOptionKeyMode}
            isActivePane={isSplit && activeLeafId === leafId}
            isActive={
              (isSplit ? activeLeafId === leafId : true) &&
              !anyOverlayOpen &&
              closeFocusHold?.terminalId !== terminal.id
            }
            onActivatePane={() =>
              activeProjectId && setActiveSplitCell(activeProjectId, leafId)
            }
            onSwitchMode={onSwitchToConversation && paneCanSwitchMode(preset, !!activeProject?.remote) ? (force) => onSwitchToConversation(terminal.id, force) : undefined}
            enableWebgl={!isSplit}
          /></LocalErrorBoundary>
        );
      })}
      {hiddenTerminals.map((t) => {
        const project = findProject(projects, t.projectSlug);
        const projectPresets =
          project?.remote && remotePresetsByProject[t.projectSlug]
            ? remotePresetsByProject[t.projectSlug]
            : presets;
        const preset = getPreset(projectPresets, t.presetId);
        const overrideTheme = preset.themeId
          ? themes.find((th) => th.id === preset.themeId)
          : null;
        const colorsForTerminal: ThemeColors =
          overrideTheme?.colors ?? skinThemeColors ?? activeThemeColors;
        if (t.presetId === PRESET_ID_BOARD) return null;
        return paneMode(preset, t, !!project?.remote) === "gui" ? null : (
          <LocalErrorBoundary key={t.id} label="Terminal" className="aya-pane" style={{ display: "none" }}><TerminalView
            terminal={t}
            preset={preset}
            {...terminalSpawn(project, preset, t, resumePanes, homeDir)}
            snippets={snippets}
            snippetsOpen={false}
            onSnippetsOpenChange={ignoreSnippetsOpenChange}
            isVisible={false}
            cwd={project?.remote ? homeDir : t.cwd}
            lastActivity={lastActivityRef.current[t.id]}
            fontFamily={effectiveTerminalFontFamily}
            fontSize={fontSize}
            themeColors={colorsForTerminal}
            findOpen={false}
            onCloseFind={closeFindPane}
            onOpenSettings={openSettings}
            onCloseProject={closeProject}
            onRequestRestart={() => restartTerminal(t.id)}
            onSpawnFailure={onSpawnFailure}
            restartTrigger={restartTriggers[t.id] ?? 0}
            macOptionKeyMode={macOptionKeyMode}
            onSwitchMode={onSwitchToConversation && paneCanSwitchMode(preset, !!project?.remote) ? (force) => onSwitchToConversation(t.id, force) : undefined}
            enableWebgl={false}
          /></LocalErrorBoundary>
        );
      })}
      {Object.values(terminals).map(terminal => {
        const project = findProject(projects, terminal.projectSlug);
        const preset = getPreset(presets, terminal.presetId);
        if (paneMode(preset, terminal, !!project?.remote) !== "gui" || terminal.spawnDeferred) return null;
        const pane = paneRects.find(p => p.terminalId === terminal.id);
        return (
          <LocalErrorBoundary key={`${terminal.id}:${restartTriggers[terminal.id] ?? 0}`} label="Conversation"
            className={`aya-pane${isSplit && pane && activeLeafId === pane.leafId ? " aya-pane--active-split" : ""}`}
            onActivate={() => { if (activeProjectId && pane) setActiveSplitCell(activeProjectId, pane.leafId); }}
            onDispose={() => {
              if (!guiRendererRecoveryInProgress()) void window.ayaGui?.invoke(terminal.id, 'dispose-pane').catch(error => console.error('Could not close failed conversation', error));
            }}
            style={pane ? paneStyleFromRect(isSplit, pane.rect) : { display: "none" }} onError={() => beginGuiPaneRecovery(terminal.id)}><ConversationView
            terminal={terminal}
            preset={preset}
            snippets={snippets}
            snippetsOpen={snippetDrawerTerminalId === terminal.id}
            onSnippetsOpenChange={(open) => setSnippetDrawerTerminalId(open ? terminal.id : null)}
            onOpenSettings={openSettings}
            hidden={!pane}
            paneStyle={pane ? paneStyleFromRect(isSplit, pane.rect) : undefined}
            isActivePane={Boolean(isSplit && pane && activeLeafId === pane.leafId)}
            onActivatePane={() => {
              if (activeProjectId && pane) setActiveSplitCell(activeProjectId, pane.leafId);
            }}
            onReportStatus={onReportPaneStatus}
            listSiblingTerminals={listSiblingTerminals}
            findOpen={findInPaneFor === terminal.id}
            onSwitchToTerminal={onSwitchToTerminal ? (sessionId) => onSwitchToTerminal(terminal.id, sessionId) : undefined}
            onCloseFind={closeFindPane}
            headerSlot={headerSlot}
          /></LocalErrorBoundary>
        );
      })}
      {[...modeTransitions].map(([id, state]) => {
        // Terminal ⇄ Conversation: one veil over the pane body while either view loads (PaneModeVeil).
        const pane = paneRects.find((p) => p.terminalId === id);
        if (!state.transition || !pane || terminals[id]?.projectSlug !== activeProjectId) return null;
        return <PaneModeVeil key={`veil:${id}`} terminalId={id} transition={state.transition} style={paneStyleFromRect(isSplit, pane.rect)} />;
      })}
      {activeProjectId &&
        paneDividers.map((divider) => (
          <SplitResizeHandle
            key={divider.splitId}
            divider={divider}
            onResize={(ratio) => resizeSplit(activeProjectId, divider.splitId, ratio)}
          />
        ))}
      {projectTerminals.length === 0 && activeProject && (
        <div className="aya-pane">
          <div className="aya-pane-header">
            <span className="aya-pane-header-title">
              {emptyProjectPaneTitle(activeProject)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
});
