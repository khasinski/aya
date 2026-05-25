import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ProjectConfig } from "../types";

interface Props {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  homeDir: string;
  isDev: boolean;
  /** When true, the gear is disabled and the "+ New project" sentinel is
   *  inert. Used while a blocking modal (MissingDir / NewProject) is up
   *  so the user can't stack Settings on top of it. */
  blockChrome: boolean;
  onSelectProject: (slug: string) => void;
  onNewProject: () => void;
  /** Closes the project in the current session. Does NOT delete the JSON
   *  file — on restart, the project reopens. */
  onCloseProject: (slug: string) => void;
  onRenameProject: (slug: string, newName: string) => void;
  onReorderProjects: (orderedSlugs: string[]) => void;
  onOpenSettings: () => void;
  projectBadges?: Record<string, number>;
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
  activeProjectId,
  homeDir,
  isDev,
  blockChrome,
  onSelectProject,
  onNewProject,
  onCloseProject,
  onRenameProject,
  onReorderProjects,
  onOpenSettings,
  projectBadges = {},
}: Props) {
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Regular (non-trackpad) mice only emit deltaY. Translate that into
  // horizontal scrolling on the tab strip so users can reach hidden tabs
  // without having to grab the (now hidden) scrollbar.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      // Trackpads emit deltaX for horizontal gestures — let the browser
      // handle those natively. Only intercept vertical-wheel intent.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
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
        <span>{isDev ? "aya dev" : "aya"}</span>
      </div>
      <div className="aya-tabs" ref={tabsRef}>
        {projects.map((p) => {
          const isActive = p.slug === activeProjectId;
          const badge = projectBadges[p.slug] ?? 0;
          const isRenaming = renamingSlug === p.slug;
          const confirmAndRemove = () => {
            if (
              confirm(
                `Close project "${p.name}" in this session?\n\nThe config file (~/.aya/projects/${p.slug}.json) stays on disk and the project reopens on next launch.`,
              )
            ) {
              onCloseProject(p.slug);
            }
          };
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
              {badge > 0 && (
                <span
                  className="aya-tab-bell"
                  title={`${badge} terminal${badge > 1 ? "s" : ""} waiting for input`}
                />
              )}
              <span
                className="aya-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  confirmAndRemove();
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
