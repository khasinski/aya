import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../colors";
import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ProjectConfig, UsageAccount } from "../types";
import type { SettingsTab } from "../settings-tabs";
import { UsageChip } from "./UsageChip";

// Project tab width bounds (px): tabs shrink to min, then overflow the strip.
const TAB_MIN_WIDTH_PX = 120;
const TAB_MAX_WIDTH_PX = 320;
// Brand accents for the per-agent usage chips.

interface ProjectAttention {
  count: number;
  level: "done" | "waiting" | "error";
}

interface Props {
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  activeProjectId: string | null;
  homeDir: string;
  isDev: boolean;
  platform: NodeJS.Platform;
  isFullScreen: boolean;
  isMaximized: boolean;
  /** When true, the gear is disabled and the "+ New project" sentinel is
   *  inert. Used while a blocking modal (MissingDir / NewProject) is up
   *  so the user can't stack Settings on top of it. */
  blockChrome: boolean;
  onSelectProject: (slug: string) => void;
  onOpenProject: (slug: string) => void;
  onNewProject: () => void;
  /** Closes the project tab without deleting the project config. */
  onCloseProject: (slug: string) => void;
  onRenameProject: (slug: string, newName: string) => void;
  onReorderProjects: (orderedSlugs: string[]) => void;
  onOpenSearch: () => void;
  onOpenSettings: (tab?: SettingsTab) => void;
  onMinimizeWindow: () => void;
  onToggleMaximizeWindow: () => void;
  onToggleFullScreenWindow: () => void;
  onCloseWindow: () => void;
  projectBadges?: Record<string, ProjectAttention>;
  /** Account-wide Claude usage snapshots. Read-only. */
  usageAccounts?: UsageAccount[];
  /** Account-wide Codex usage snapshots. Read-only. */
  codexUsageAccounts?: UsageAccount[];
  showUsageHarnessName: boolean;
}

function compactDir(directory: string, home: string): string {
  if (!directory) return "";
  if (!home) return directory;
  if (directory === home) return "~";
  if (directory.startsWith(home + "/")) return "~" + directory.slice(home.length);
  return directory;
}

export function TopBar({
  projects,
  closedProjects,
  activeProjectId,
  homeDir,
  isDev,
  platform,
  isFullScreen,
  isMaximized,
  blockChrome,
  onSelectProject,
  onOpenProject,
  onNewProject,
  onCloseProject,
  onRenameProject,
  onReorderProjects,
  onOpenSearch,
  onOpenSettings,
  onMinimizeWindow,
  onToggleMaximizeWindow,
  onToggleFullScreenWindow,
  onCloseWindow,
  projectBadges = {},
  usageAccounts = [],
  codexUsageAccounts = [],
  showUsageHarnessName,
}: Props) {
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);
  const [showRecent, setShowRecent] = useState(false);

  useEffect(() => {
    if (!showRecent) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!recentRef.current?.contains(e.target as Node)) setShowRecent(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showRecent]);

  // Route ANY wheel/trackpad delta over the tab strip into horizontal
  // scroll. macOS trackpad horizontal swipes default to history navigation
  // in Chromium (we counter that with overscroll-behavior in CSS) and
  // regular mice only emit deltaY, so the safest thing is to always claim
  // the event and translate whichever axis the user gave us.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      const delta =
        Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag-and-drop state for project tab reordering.
  const [dragSlug, setDragSlug] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    slug: string;
    before: boolean;
  } | null>(null);

  const handleDragStart = (
    e: DragEvent<HTMLDivElement>,
    slug: string,
  ) => {
    setDragSlug(slug);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", slug);
  };
  const handleDragOver = (
    e: DragEvent<HTMLDivElement>,
    slug: string,
  ) => {
    if (!dragSlug || dragSlug === slug) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    setDropTarget((prev) =>
      prev && prev.slug === slug && prev.before === before
        ? prev
        : { slug, before },
    );
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!dragSlug || !dropTarget) {
      setDragSlug(null);
      setDropTarget(null);
      return;
    }
    const fromIdx = projects.findIndex((p) => p.slug === dragSlug);
    const targetIdx = projects.findIndex((p) => p.slug === dropTarget.slug);
    if (fromIdx < 0 || targetIdx < 0) {
      setDragSlug(null);
      setDropTarget(null);
      return;
    }
    const order = projects.map((p) => p.slug);
    order.splice(fromIdx, 1);
    let insertIdx = targetIdx;
    if (fromIdx < targetIdx) insertIdx -= 1;
    if (!dropTarget.before) insertIdx += 1;
    order.splice(insertIdx, 0, dragSlug);
    onReorderProjects(order);
    setDragSlug(null);
    setDropTarget(null);
  };
  const handleDragEnd = () => {
    setDragSlug(null);
    setDropTarget(null);
  };

  const startRename = (project: ProjectConfig) => {
    setRenamingSlug(project.slug);
    setDraft(project.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const commitRename = () => {
    if (renamingSlug) {
      const trimmed = draft.trim();
      if (trimmed) onRenameProject(renamingSlug, trimmed);
    }
    setRenamingSlug(null);
  };
  const cancelRename = () => setRenamingSlug(null);

  return (
    <header className="aya-topbar">
      {platform === "darwin" && (
        <div className="aya-mac-window-controls" aria-label="Window controls">
          <button
            className="aya-mac-window-control aya-mac-window-control--close"
            title="Close"
            aria-label="Close"
            onClick={onCloseWindow}
          >
            <svg
              className="aya-mac-window-control-icon"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path d="M3.25 3.25L8.75 8.75M8.75 3.25L3.25 8.75" />
            </svg>
          </button>
          <button
            className="aya-mac-window-control aya-mac-window-control--minimize"
            title="Minimize"
            aria-label="Minimize"
            onClick={onMinimizeWindow}
          >
            <svg
              className="aya-mac-window-control-icon"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path d="M3 6H9" />
            </svg>
          </button>
          <button
            className="aya-mac-window-control aya-mac-window-control--fullscreen"
            title={isFullScreen ? "Exit full screen" : "Full screen"}
            aria-label={isFullScreen ? "Exit full screen" : "Full screen"}
            onClick={onToggleFullScreenWindow}
          >
            <svg
              className="aya-mac-window-control-icon"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              {isFullScreen ? (
                <>
                  <path d="M4.5 2.75V4.5H2.75" />
                  <path d="M7.5 9.25V7.5H9.25" />
                </>
              ) : (
                <>
                  <path d="M7.5 2.75H9.25V4.5" />
                  <path d="M4.5 9.25H2.75V7.5" />
                </>
              )}
            </svg>
          </button>
        </div>
      )}
      <div className="aya-brand">
        <span
          className="aya-brand-dot"
          style={isDev ? { background: "#a371f7" } : undefined}
        />
        <span>{isDev ? "Aya Dev" : "Aya"}</span>
      </div>
      <div className="aya-tabs" ref={tabsRef}>
        {projects.map((p) => {
          const isActive = p.slug === activeProjectId;
          const badge = projectBadges[p.slug];
          const isRenaming = renamingSlug === p.slug;
          const isDragging = dragSlug === p.slug;
          const isRemote = !!p.remote;
          const displayPath = p.remote
            ? `${p.remote.label}:${p.remote.directory}`
            : compactDir(p.directory, homeDir);
          const isDropTarget = dropTarget?.slug === p.slug;
          const dropClass = isDropTarget
            ? dropTarget.before
              ? "aya-tab--drop-before"
              : "aya-tab--drop-after"
            : "";
          return (
            <div
              key={p.slug}
              className={`aya-tab ${isActive ? "aya-tab--active" : ""} ${
                isDragging ? "aya-tab--dragging" : ""
              } ${isRemote ? "aya-tab--remote" : ""} ${dropClass}`}
              // Keep this in sync with the CSS fallback below. Tabs grow to
              // fill spare room, shrink to 120px, then overflow the strip.
              style={{
                flex: "1 1 240px",
                minWidth: TAB_MIN_WIDTH_PX,
                maxWidth: TAB_MAX_WIDTH_PX,
              }}
              draggable={!isRenaming}
              onDragStart={(e) => handleDragStart(e, p.slug)}
              onDragOver={(e) => handleDragOver(e, p.slug)}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
              onClick={() => !isRenaming && onSelectProject(p.slug)}
              title={
                isRenaming
                  ? undefined
                  : `${p.name} - ${displayPath} · double-click to rename · drag to reorder`
              }
            >
              {isRenaming ? (
                <input
                  ref={inputRef}
                  className="aya-tab-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  autoFocus
                />
              ) : (
                <span
                  className="aya-tab-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(p);
                  }}
                >
                  {isRemote && (
                    <span className="aya-tab-remote-chip" title={displayPath}>
                      SSH
                    </span>
                  )}
                  {p.name}
                </span>
              )}
              <span className="aya-tab-path">{displayPath}</span>
              {badge && (
                <span
                  className={`aya-tab-bell aya-tab-bell--${badge.level}`}
                  title={`${badge.count} terminal${badge.count > 1 ? "s" : ""} need attention`}
                />
              )}
              <span
                className="aya-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseProject(p.slug);
                }}
                title="Close project"
              >
                ×
              </span>
            </div>
          );
        })}
        <div
          className={`aya-tab-new ${blockChrome ? "aya-tab-new--disabled" : ""}`}
          title="New project"
          onClick={blockChrome ? undefined : onNewProject}
          aria-disabled={blockChrome}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>add</span>
        </div>
      </div>
      <div className="aya-topbar-right">
        {usageAccounts.length > 0 && (
          <UsageChip
            accounts={usageAccounts}
            label="Claude"
            accent={CLAUDE_BRAND_COLOR}
            showHarnessName={showUsageHarnessName}
          />
        )}
        {codexUsageAccounts.length > 0 && (
          <UsageChip
            accounts={codexUsageAccounts}
            label="Codex"
            accent={CODEX_BRAND_COLOR}
            showHarnessName={showUsageHarnessName}
          />
        )}
        <div className="aya-recent-projects" ref={recentRef}>
          <button
            className="aya-iconbtn"
            title={
              blockChrome
                ? "Recent projects (close the open dialog first)"
                : "Recent projects"
            }
            aria-label="Recent projects"
            // Inline dropdown, not a modal — keep terminal focus (same reason
            // as the usage chips); without this the folder toggle forces a
            // re-click to resume typing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowRecent((v) => !v)}
            disabled={blockChrome}
            aria-haspopup="menu"
            aria-expanded={showRecent}
          >
            <span style={{ fontFamily: "Material Symbols Outlined" }}>
              folder_open
            </span>
          </button>
          {showRecent && (
            <div className="aya-recent-menu" role="menu">
              <div className="aya-recent-menu-title">Recent projects</div>
              {closedProjects.length === 0 ? (
                <div className="aya-recent-menu-empty">No closed projects</div>
              ) : (
                closedProjects.map((p) => (
                  <button
                    key={p.slug}
                    className="aya-recent-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShowRecent(false);
                      onOpenProject(p.slug);
                    }}
                  >
                    <span className="aya-recent-menu-name">{p.name}</span>
                    <span className="aya-recent-menu-path">
                      {compactDir(p.directory, homeDir)}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          className="aya-iconbtn"
          title={
            blockChrome
              ? "Search (close the open dialog first)"
              : "Search (Cmd/Ctrl+K or Shift Shift)"
          }
          onClick={onOpenSearch}
          disabled={blockChrome}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>search</span>
        </button>
        <button
          className="aya-iconbtn"
          title={blockChrome ? "Settings (close the open dialog first)" : "Settings"}
          onClick={() => onOpenSettings()}
          disabled={blockChrome}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>settings</span>
        </button>
        {platform === "linux" && (
          <div className="aya-window-controls" aria-label="Window controls">
            <button
              className="aya-window-control"
              title="Minimize"
              aria-label="Minimize"
              onClick={onMinimizeWindow}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>
                remove
              </span>
            </button>
            <button
              className="aya-window-control"
              title={isMaximized ? "Restore" : "Maximize"}
              aria-label={isMaximized ? "Restore" : "Maximize"}
              onClick={onToggleMaximizeWindow}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>
                {isMaximized ? "filter_none" : "crop_square"}
              </span>
            </button>
            <button
              className="aya-window-control aya-window-control--close"
              title="Close"
              aria-label="Close"
              onClick={onCloseWindow}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>
                close
              </span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
