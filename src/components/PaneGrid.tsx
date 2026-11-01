import type { RefObject } from "react";
import { guiSupportedAgent } from "../agentPreset";
import { emptyProjectPaneTitle, paneStyleFromRect } from "../pane-grid";
import { findProject, terminalSpawn } from "../project-helpers";
import type { SettingsTab } from "../settings-tabs";
import type { DividerRect, LeafRect } from "../split-tree";
import type { MacOptionKeyMode } from "../terminal-option-key";
import {
  getPreset,
  type Preset,
  type ProjectConfig,
  type Snippet,
  type TerminalState,
  type Theme,
  type ThemeColors,
} from "../types";
import { SplitResizeHandle } from "./SplitResizeHandle";
import { ConversationView } from "./ConversationView";
import { TerminalView } from "./TerminalView";

interface Props {
  isSplit: boolean;
  paneRects: LeafRect[];
  terminals: Record<string, TerminalState>;
  activeLeafId: string | null;
  activeProjectId: string | null;
  setActiveSplitCell: (slug: string, leafId: string) => void;
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
  openSettings: (tab?: SettingsTab) => void;
  closeProject: (slug: string) => void;
  restartTerminal: (terminalId: string) => void;
  onSpawnFailure: (terminalId: string) => void;
  restartTriggers: Record<string, number>;
  macOptionKeyMode: MacOptionKeyMode;
  anyOverlayOpen: boolean;
  closeFocusHold: { slug: string; terminalId: string } | null;
  hiddenTerminals: TerminalState[];
  projects: ProjectConfig[];
  remotePresetsByProject: Record<string, Preset[]>;
  presets: Preset[];
  ignoreSnippetsOpenChange: (open: boolean) => void;
  paneDividers: DividerRect[];
  resizeSplit: (slug: string, splitId: string, ratio: number) => void;
  projectTerminals: TerminalState[];
}

export function PaneGrid({
  isSplit,
  paneRects,
  terminals,
  activeLeafId,
  activeProjectId,
  setActiveSplitCell,
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
  openSettings,
  closeProject,
  restartTerminal,
  onSpawnFailure,
  restartTriggers,
  macOptionKeyMode,
  anyOverlayOpen,
  closeFocusHold,
  hiddenTerminals,
  projects,
  remotePresetsByProject,
  presets,
  ignoreSnippetsOpenChange,
  paneDividers,
  resizeSplit,
  projectTerminals,
}: Props) {
  return (
    <div className={`aya-panes ${isSplit ? "aya-panes--split" : ""}`}>
      {paneRects.map(({ leafId, terminalId, rect }) => {
        const terminal = terminalId ? terminals[terminalId] : null;
        // Panes are positioned from the tree's rectangles rather than
        // nested to match it: nesting would move each TerminalView in
        // the React tree on every reshape and remount the terminal.
        const paneStyle = paneStyleFromRect(isSplit, rect);
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
        return preset.interfaceMode === "gui" && guiSupportedAgent(preset) !== null && !activeProject?.remote ? null : (
          <TerminalView
            key={terminal.id}
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
            enableWebgl={!isSplit}
          />
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
        return preset.interfaceMode === "gui" && guiSupportedAgent(preset) !== null && !project?.remote ? null : (
          <TerminalView
            key={t.id}
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
            enableWebgl={false}
          />
        );
      })}
      {Object.values(terminals).map(terminal => {
        const project = findProject(projects, terminal.projectSlug);
        const preset = getPreset(presets, terminal.presetId);
        if (preset.interfaceMode !== "gui" || !guiSupportedAgent(preset) || project?.remote || terminal.spawnDeferred) return null;
        const pane = paneRects.find(p => p.terminalId === terminal.id);
        return <ConversationView key={`${terminal.id}:${restartTriggers[terminal.id] ?? 0}`} terminal={terminal} preset={preset} hidden={!pane} paneStyle={pane ? paneStyleFromRect(isSplit, pane.rect) : undefined} />;
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
}
