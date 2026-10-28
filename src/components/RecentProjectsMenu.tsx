import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectConfig } from "../types";
import { compactDir } from "../project-path";

/** The folder button and its dropdown of closed projects, with a filter. Shared by the top bar and
 *  both left-rail layouts, which style the button and the menu differently. */
export function RecentProjectsMenu({
  closedProjects,
  homeDir,
  blockChrome,
  onOpenProject,
  buttonClassName,
  menuClassName = "",
}: {
  closedProjects: ProjectConfig[];
  homeDir: string;
  blockChrome: boolean;
  onOpenProject: (slug: string) => void;
  buttonClassName: string;
  menuClassName?: string;
}) {
  const [showRecent, setShowRecent] = useState(false);
  const [recentFilter, setRecentFilter] = useState("");
  const recentRef = useRef<HTMLDivElement>(null);
  const recentFilterRef = useRef<HTMLInputElement>(null);

  const normalizedRecentFilter = recentFilter.trim().toLowerCase();
  const filteredClosedProjects = useMemo(
    () =>
      normalizedRecentFilter.length === 0
        ? closedProjects
        : closedProjects.filter((p) => {
            const path = compactDir(p.directory, homeDir);
            return (
              p.name.toLowerCase().includes(normalizedRecentFilter) ||
              path.toLowerCase().includes(normalizedRecentFilter) ||
              p.directory.toLowerCase().includes(normalizedRecentFilter)
            );
          }),
    [normalizedRecentFilter, closedProjects, homeDir],
  );

  useEffect(() => {
    if (!showRecent) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!recentRef.current?.contains(e.target as Node)) setShowRecent(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showRecent]);

  useEffect(() => {
    if (!showRecent) {
      setRecentFilter("");
      return;
    }
    const id = window.requestAnimationFrame(() => {
      recentFilterRef.current?.focus();
      recentFilterRef.current?.select();
    });
    return () => window.cancelAnimationFrame(id);
  }, [showRecent]);

  return (
    <div className="aya-recent-projects" ref={recentRef}>
      <button
        type="button"
        className={buttonClassName}
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
        <span style={{ fontFamily: "Material Symbols Outlined" }}>folder_open</span>
      </button>
      {showRecent && (
        <div className={`aya-recent-menu ${menuClassName}`.trim()} role="menu">
          <div className="aya-recent-menu-title">Recent projects</div>
          {closedProjects.length > 0 && (
            <div className="aya-recent-menu-filter">
              <span
                className="aya-recent-menu-filter-icon"
                style={{ fontFamily: "Material Symbols Outlined" }}
                aria-hidden="true"
              >
                search
              </span>
              <input
                ref={recentFilterRef}
                value={recentFilter}
                onChange={(e) => setRecentFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setShowRecent(false);
                  }
                }}
                placeholder="Filter projects"
                aria-label="Filter recent projects"
              />
            </div>
          )}
          {closedProjects.length === 0 ? (
            <div className="aya-recent-menu-empty">No closed projects</div>
          ) : filteredClosedProjects.length === 0 ? (
            <div className="aya-recent-menu-empty">No matching projects</div>
          ) : (
            filteredClosedProjects.map((p) => (
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
  );
}
