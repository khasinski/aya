import { useEffect, useRef, useState } from "react";
import { getPreset, type Preset, type TerminalState } from "../types";

interface Props {
  terminals: TerminalState[];
  activeId: string | null;
  sidebarWidth: number;
  bellStyle?: "dot" | "icon" | "animated";
  presets: Preset[];
  // Set of terminal ids whose PTY emitted output in the last few seconds.
  // The status dot only pulses while in this set; otherwise it sits steady.
  recentlyActiveIds: Set<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onLaunch: (preset: Preset) => void;
  onResize: (width: number) => void;
}

function BellIcon({ style }: { style: "dot" | "icon" | "animated" }) {
  if (style === "dot") return <span className="aya-bell aya-bell--dot" />;
  if (style === "animated")
    return <span className="aya-bell aya-bell--animated">notifications</span>;
  return <span className="aya-bell aya-bell--icon">notifications</span>;
}

export function Sidebar({
  terminals,
  activeId,
  sidebarWidth,
  bellStyle = "icon",
  presets,
  recentlyActiveIds,
  onSelect,
  onClose,
  onRename,
  onLaunch,
  onResize,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = (t: TerminalState) => {
    setRenamingId(t.id);
    setDraft(t.name);
    setTimeout(() => inputRef.current?.select(), 0);
  };
  const commit = () => {
    if (renamingId) {
      const trimmed = draft.trim();
      if (trimmed) onRename(renamingId, trimmed);
    }
    setRenamingId(null);
  };
  const cancel = () => setRenamingId(null);

  // Drag-resize the sidebar.
  const resizing = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.max(180, Math.min(380, e.clientX));
      onResize(w);
    };
    const up = () => {
      resizing.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onResize]);

  return (
    <aside className="aya-sidebar" style={{ width: sidebarWidth }}>
      <div className="aya-sidebar-header">
        <span>{terminals.length} terminals</span>
      </div>
      <div className="aya-sidebar-list">
        {terminals.map((t) => {
          const isActive = t.id === activeId;
          const preset = getPreset(presets, t.presetId);
          return (
            <div
              key={t.id}
              className={`aya-sidebar-row ${isActive ? "aya-sidebar-row--active" : ""}`}
              onClick={() => onSelect(t.id)}
              title={`${t.name} — ${t.cwd}`}
            >
              <span
                className="aya-sidebar-icon"
                style={preset.color ? { color: preset.color } : undefined}
              >
                {preset.icon}
              </span>
              <span
                className={`aya-sidebar-statusdot aya-sidebar-statusdot--${t.status} ${
                  recentlyActiveIds.has(t.id)
                    ? "aya-sidebar-statusdot--blinking"
                    : ""
                }`}
              />
              {renamingId === t.id ? (
                <input
                  ref={inputRef}
                  className="aya-sidebar-rename"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancel();
                    }
                  }}
                  autoFocus
                />
              ) : (
                <span
                  className="aya-sidebar-name"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startRename(t);
                  }}
                  title="Double-click to rename"
                >
                  {t.name}
                </span>
              )}
              {t.bell && <BellIcon style={bellStyle} />}
              <span
                className="aya-sidebar-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                title="Close terminal"
              >
                ×
              </span>
            </div>
          );
        })}
      </div>
      <div className="aya-launcher">
        <div className="aya-launcher-label">New terminal</div>
        <div className="aya-launcher-row">
          {presets.map((p) => (
            <button
              key={p.id}
              className="aya-launcher-btn"
              onClick={() => onLaunch(p)}
              title={p.command}
            >
              <span
                className="aya-launcher-btn-icon"
                style={p.color ? { color: p.color } : undefined}
              >
                {p.icon}
              </span>
              <span className="aya-launcher-btn-name">{p.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        className="aya-sidebar-resize"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: sidebarWidth - 2,
          width: 4,
        }}
        onMouseDown={() => {
          resizing.current = true;
          document.body.style.cursor = "col-resize";
        }}
      />
    </aside>
  );
}
