import { useEffect, useRef, useState } from "react";
import type { UsageAccount, UsageData, UsageWindow } from "../types";

// A usage snapshot older than this means the source stopped updating — dim it.
const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;
const CHIP_MUTED_COLOR = "var(--fg-tertiary)";
const CHIP_BORDER_COLOR = "var(--border)";

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

function averageWeeklyPct(accounts: UsageAccount[]): number {
  if (accounts.length === 0) return 0;
  const total = accounts.reduce((sum, account) => {
    return sum + account.usage.sevenDay.pct;
  }, 0);
  return total / accounts.length;
}

function allUsageStale(accounts: UsageAccount[]): boolean {
  return accounts.length > 0 && accounts.every((a) => isUsageStale(a.usage));
}

/** Account-wide usage chip (icon + popover) for one agent. The top-level number
 *  is average weekly percent used across detected accounts; the popover shows
 *  each account's own limits. */
export function UsageChip({
  accounts,
  label,
  accent,
  showHarnessName,
}: {
  accounts: UsageAccount[];
  label: string;
  accent: string;
  showHarnessName: boolean;
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

  if (accounts.length === 0) return null;

  const stale = allUsageStale(accounts);
  const weeklyPct = averageWeeklyPct(accounts);
  const ringPct = Math.max(0, Math.min(100, weeklyPct));
  const accountText =
    accounts.length === 1 ? "1 account" : `${accounts.length} accounts`;

  return (
    <div className="aya-recent-projects" ref={ref}>
      <button
        className="aya-iconbtn"
        title={`${label} usage — ${accountText}, account-wide (all sessions, not this project)`}
        aria-label={`${label} usage, account-wide`}
        // Don't steal keyboard focus from the active terminal: peeking at usage
        // shouldn't force a re-click to resume typing (the old Settings-focus
        // bug). preventDefault on mousedown keeps focus where it was; the click
        // still toggles the popover.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: "auto",
          gap: showHarnessName ? 7 : 6,
          padding: showHarnessName ? "0 9px" : "0 7px",
          opacity: stale ? 0.5 : 1,
          background: showHarnessName ? "var(--bg-tertiary)" : undefined,
          // .aya-iconbtn sets the Material Symbols icon font; the chip has no
          // glyph icon, so reset to the UI sans so label/number text doesn't
          // inherit the icon font (which rendered them in the wrong typeface).
          fontFamily: "var(--font-sans)",
        }}
      >
        {showHarnessName ? (
          <>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: accent,
                flex: "0 0 auto",
              }}
            />
            <span style={{ color: CHIP_MUTED_COLOR, fontSize: 11 }}>{label}</span>
          </>
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: 19,
              height: 19,
              borderRadius: "50%",
              background: `conic-gradient(${accent} ${ringPct}%, ${CHIP_BORDER_COLOR} 0)`,
              position: "relative",
              flex: "0 0 auto",
            }}
          >
            <span
              style={{
                position: "absolute",
                inset: 4,
                borderRadius: "50%",
                background: "var(--bg-secondary)",
              }}
            />
          </span>
        )}
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            fontSize: 12,
            fontWeight: showHarnessName ? 650 : 600,
            color: "var(--fg-primary)",
            // Numbers always in the mono stack (tabular), matching the mockup.
            fontFamily:
              '"SF Mono", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
          }}
        >
          {Math.round(weeklyPct)}%
        </span>
      </button>
      {open && (
        <div className="aya-recent-menu" role="menu" style={{ width: 280, padding: 12 }}>
          <div className="aya-recent-menu-title">{label} — account-wide</div>
          <div style={{ color: CHIP_MUTED_COLOR, fontSize: 12, marginBottom: 10 }}>
            {accountText}, all sessions, not this project
          </div>
          {accounts.map((account, index) => {
            const accountStale = isUsageStale(account.usage);
            return (
              <div
                key={account.id}
                style={{
                  borderTop:
                    index === 0 ? undefined : `1px solid ${CHIP_BORDER_COLOR}`,
                  paddingTop: index === 0 ? 0 : 10,
                  marginTop: index === 0 ? 0 : 10,
                  opacity: accountStale ? 0.55 : 1,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: 12,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {account.label}
                  </span>
                  <span
                    style={{
                      color: CHIP_MUTED_COLOR,
                      fontSize: 11,
                      fontVariantNumeric: "tabular-nums",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {accountStale ? "stale · " : ""}updated{" "}
                    {fmtClock(account.usage.updatedAt)}
                  </span>
                </div>
                <UsageRow label="5h" win={account.usage.fiveHour} accent={accent} />
                <UsageRow
                  label="week"
                  win={account.usage.sevenDay}
                  accent={accent}
                />
              </div>
            );
          })}
          {accounts.length > 1 && (
            <div
              style={{
                color: CHIP_MUTED_COLOR,
                fontSize: 11,
                marginTop: 10,
                borderTop: `1px solid ${CHIP_BORDER_COLOR}`,
                paddingTop: 8,
              }}
            >
              {Math.round(weeklyPct)}% average weekly used
            </div>
          )}
        </div>
      )}
    </div>
  );
}
