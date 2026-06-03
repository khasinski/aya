import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ProjectConfig, UsageData, UsageWindow } from "../types";
import { CLAUDE_BRAND_COLOR } from "../theme";

// Project tab width bounds (px): tabs shrink to min, then overflow the strip.
const TAB_MIN_WIDTH_PX = 120;
const TAB_MAX_WIDTH_PX = 320;
// A usage snapshot older than this means the hook stopped writing — dim it.
const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;
// Usage-chip palette: Aya's muted text and panel border (Claude brand accent
// comes from the shared theme). One-off; not worth a shared module.
const CHIP_MUTED_COLOR = "#8b949e";
const CHIP_BORDER_COLOR = "#30363d";

function isUsageStale(u: UsageData): boolean {
  const t = Date.parse(u.updatedAt);
  return !Number.isFinite(t) || Date.now() - t > USAGE_STALE_AFTER_MS;
}

function fmtClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtReset(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** One limit window in the usage popover: label, percent, bar, reset time. */
function UsageRow({ label, win }: { label: string; win: UsageWindow }) {
  const filled = Math.max(0, Math.min(100, win.pct));
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span style={{ color: CHIP_MUTED_COLOR }}>{label}</span>
        <span style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(win.pct)}%
        </span>
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: CHIP_BORDER_COLOR,
          overflow: "hidden",
          marginTop: 3,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${filled}%`,
            background: CLAUDE_BRAND_COLOR,
            borderRadius: 3,
          }}
        />
      </div>
      {win.resetsAt && (
        <div style={{ color: CHIP_MUTED_COLOR, fontSize: 11, marginTop: 2 }}>
          resets {fmtReset(win.resetsAt)}
        </div>
      )}
    </div>
  );
}

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
  onOpenSettings: () => void;
  projectBadges?: Record<string, ProjectAttention>;
  /** Account-wide Claude usage snapshot (null hides the chip). Read-only. */
  usage?: UsageData | null;
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
  blockChrome,
  onSelectProject,
  onOpenProject,
  onNewProject,
  onCloseProject,
  onRenameProject,
  onReorderProjects,
  onOpenSearch,
  onOpenSettings,
  projectBadges = {},
  usage = null,
}: Props) {
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLDivElement>(null);
  const [showRecent, setShowRecent] = useState(false);
  const usageRef = useRef<HTMLDivElement>(null);
  const [showUsage, setShowUsage] = useState(false);

  useEffect(() => {
    if (!showRecent) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!recentRef.current?.contains(e.target as Node)) setShowRecent(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showRecent]);

  useEffect(() => {
    if (!showUsage) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!usageRef.current?.contains(e.target as Node)) setShowUsage(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showUsage]);

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
              } ${dropClass}`}
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
                  : `${p.name} — ${p.directory} · double-click to rename · drag to reorder`
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
                  {p.name}
                </span>
              )}
              <span className="aya-tab-path">{compactDir(p.directory, homeDir)}</span>
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
          ＋
        </div>
      </div>
      <div className="aya-topbar-right">
        {usage && (
          <div className="aya-recent-projects" ref={usageRef}>
            <button
              className="aya-iconbtn"
              title="Claude usage — account-wide (all sessions, not this project)"
              aria-label="Claude usage, account-wide"
              onClick={() => setShowUsage((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showUsage}
              style={{
                width: "auto",
                gap: 6,
                padding: "0 8px",
                opacity: isUsageStale(usage) ? 0.5 : 1,
              }}
            >
              <span style={{ fontFamily: "Material Symbols Outlined" }}>
                speed
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12 }}>
                {Math.round(usage.sevenDay.pct)}%
              </span>
            </button>
            {showUsage && (
              <div
                className="aya-recent-menu"
                role="menu"
                style={{ width: 240, padding: 12 }}
              >
                <div className="aya-recent-menu-title">Claude — account-wide</div>
                <div
                  style={{ color: CHIP_MUTED_COLOR, fontSize: 12, marginBottom: 10 }}
                >
                  all sessions, not this project
                </div>
                <UsageRow label="5h" win={usage.fiveHour} />
                <UsageRow label="week" win={usage.sevenDay} />
                <div
                  style={{
                    color: CHIP_MUTED_COLOR,
                    fontSize: 11,
                    marginTop: 10,
                    borderTop: `1px solid ${CHIP_BORDER_COLOR}`,
                    paddingTop: 8,
                  }}
                >
                  {isUsageStale(usage) ? "stale · " : ""}updated{" "}
                  {fmtClock(usage.updatedAt)}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="aya-recent-projects" ref={recentRef}>
          <button
            className="aya-iconbtn"
            title={
              blockChrome
                ? "Recent projects (close the open dialog first)"
                : "Recent projects"
            }
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
          onClick={onOpenSettings}
          disabled={blockChrome}
        >
          <span style={{ fontFamily: "Material Symbols Outlined" }}>settings</span>
        </button>
      </div>
    </header>
  );
}
