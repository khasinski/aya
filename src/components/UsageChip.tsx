import { useEffect, useRef, useState } from "react";
import type { UsageData, UsageWindow } from "../types";

// A usage snapshot older than this means the source stopped updating — dim it.
const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;
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

/** One limit window in the popover: label, percent, bar, reset time. */
function UsageRow({
  label,
  win,
  accent,
}: {
  label: string;
  win: UsageWindow;
  accent: string;
}) {
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
            background: accent,
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

/** Account-wide usage chip (icon + popover) for one agent. The numbers are
 *  account-global — all sessions / devices share the limits, never per-project
 *  or per-terminal — so the popover says so explicitly. `accent` is the agent's
 *  brand color; `label` is e.g. "Claude" or "Codex". */
export function UsageChip({
  usage,
  label,
  accent,
}: {
  usage: UsageData;
  label: string;
  accent: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const stale = isUsageStale(usage);

  return (
    <div className="aya-recent-projects" ref={ref}>
      <button
        className="aya-iconbtn"
        title={`${label} usage — account-wide (all sessions, not this project)`}
        aria-label={`${label} usage, account-wide`}
        // Don't steal keyboard focus from the active terminal: peeking at usage
        // shouldn't force a re-click to resume typing (the old Settings-focus
        // bug). preventDefault on mousedown keeps focus where it was; the click
        // still toggles the popover.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ width: "auto", gap: 6, padding: "0 8px", opacity: stale ? 0.5 : 1 }}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", color: accent }}>
          speed
        </span>
        <span
          style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, color: accent }}
        >
          {Math.round(usage.sevenDay.pct)}%
        </span>
      </button>
      {open && (
        <div className="aya-recent-menu" role="menu" style={{ width: 240, padding: 12 }}>
          <div className="aya-recent-menu-title">{label} — account-wide</div>
          <div style={{ color: CHIP_MUTED_COLOR, fontSize: 12, marginBottom: 10 }}>
            all sessions, not this project
          </div>
          <UsageRow label="5h" win={usage.fiveHour} accent={accent} />
          <UsageRow label="week" win={usage.sevenDay} accent={accent} />
          <div
            style={{
              color: CHIP_MUTED_COLOR,
              fontSize: 11,
              marginTop: 10,
              borderTop: `1px solid ${CHIP_BORDER_COLOR}`,
              paddingTop: 8,
            }}
          >
            {stale ? "stale · " : ""}updated {fmtClock(usage.updatedAt)}
          </div>
        </div>
      )}
    </div>
  );
}
