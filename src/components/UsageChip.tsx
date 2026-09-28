import { RECENT_MENU_WIDTH_PX } from "../ui-constants";
import { useEffect, useRef, useState } from "react";
import type { GrokUsage, UsageAccount, UsageData, UsageWindow } from "../types";
import { GROK_USAGE_WINDOW_DAYS } from "../main-mirrors";

// A usage snapshot older than this means the source stopped updating — dim it.
const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;
const CHIP_MUTED_COLOR = "var(--fg-tertiary)";
const CHIP_BORDER_COLOR = "var(--border)";
const STALE_TICK_MS = 60_000;

/** Re-renders every minute, so a snapshot dims on time even when no poll
 *  brings new data. */
function useMinuteTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), STALE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);
}

function isStale(updatedAt: string): boolean {
  const t = Date.parse(updatedAt);
  return !Number.isFinite(t) || Date.now() - t > USAGE_STALE_AFTER_MS;
}

const isUsageStale = (u: UsageData) => isStale(u.updatedAt);

const updatedText = (iso: string, stale: boolean) =>
  `${stale ? "stale · " : ""}updated ${fmtClock(iso)}`;

function HarnessDot({ accent }: { accent: string }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: 8, height: 8, borderRadius: "50%", background: accent, flex: "0 0 auto" }}
    />
  );
}

function UsageRing({ pct, accent }: { pct: number; accent: string }) {
  const filled = Math.max(0, Math.min(100, pct));
  return (
    <span
      aria-hidden="true"
      style={{
        width: 19,
        height: 19,
        borderRadius: "50%",
        background: `conic-gradient(${accent} ${filled}%, ${CHIP_BORDER_COLOR} 0)`,
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
  );
}

/** Time alone reads as today, so an older snapshot also gets its date. */
function fmtClock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const when = new Date(t);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (when.toDateString() === new Date().toDateString()) return time;
  return `${when.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
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

function averageUsagePct(accounts: UsageAccount[]): {
  pct: number;
  /** Which ring the average was computed from - the popover label must not
   *  claim "weekly" for a 5h-only fallback (#92). */
  ring: "weekly" | "5h";
} {
  if (accounts.length === 0) return { pct: 0, ring: "weekly" };
  // Average the WEEKLY ring across accounts that have one; only when no
  // account exposes a weekly window (5h-only schema) fall back to the 5h
  // ring, so a lone short-window account still lights the chip instead of
  // silently skewing a "weekly" average alongside real weekly numbers.
  const weekly = accounts.filter((a) => a.usage.sevenDay !== undefined);
  const pool = weekly.length > 0 ? weekly : accounts;
  const pick = (a: UsageAccount) =>
    a.usage.sevenDay?.pct ?? a.usage.fiveHour?.pct ?? 0;
  return {
    pct: pool.reduce((sum, a) => sum + pick(a), 0) / pool.length,
    ring: weekly.length > 0 ? "weekly" : "5h",
  };
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
  useMinuteTick();

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
  const { pct: weeklyPct, ring: avgRing } = averageUsagePct(accounts);
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
            <HarnessDot accent={accent} />
            <span style={{ color: CHIP_MUTED_COLOR, fontSize: 11 }}>{label}</span>
          </>
        ) : (
          <UsageRing pct={weeklyPct} accent={accent} />
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
        <div className="aya-recent-menu" role="menu" style={{ width: RECENT_MENU_WIDTH_PX, padding: 12 }}>
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
                    {updatedText(account.usage.updatedAt, accountStale)}
                  </span>
                </div>
                {account.usage.fiveHour && (
                  <UsageRow label="5h" win={account.usage.fiveHour} accent={accent} />
                )}
                {account.usage.sevenDay && (
                  <UsageRow
                    label="week"
                    win={account.usage.sevenDay}
                    accent={accent}
                  />
                )}
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
              {Math.round(weeklyPct)}% average {avgRing} used
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Grok --------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

/** Grok cost is stored as 1e-10 USD "ticks". */
function fmtUsd(ticks: number): string {
  return `$${(ticks * 1e-10).toFixed(2)}`;
}

export function GrokUsageChip({
  usage,
  label,
  accent,
  showHarnessName,
}: {
  usage: GrokUsage | null;
  label: string;
  accent: string;
  showHarnessName: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useMinuteTick();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (!usage || (usage.turns === 0 && !usage.limit)) return null;

  const { limit } = usage;
  const hasCost = usage.costUsdTicks > 0;
  const headline = limit
    ? `${Math.round(limit.pct)}%`
    : hasCost
      ? fmtUsd(usage.costUsdTicks)
      : `${fmtTokens(usage.totalTokens)} tok`;
  const stale = limit ? isStale(limit.updatedAt) : false;

  const row = (name: string, value: string) => (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 12,
        lineHeight: 1.7,
      }}
    >
      <span style={{ color: CHIP_MUTED_COLOR }}>{name}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );

  return (
    <div className="aya-recent-projects" ref={ref}>
      <button
        className="aya-iconbtn"
        title={
          limit
            ? `${label} usage - ${Math.round(limit.pct)}% of the weekly limit, account-wide`
            : `${label} usage - last ${GROK_USAGE_WINDOW_DAYS} days, account-wide (all sessions, not this project)`
        }
        aria-label={`${label} usage, account-wide`}
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
          fontFamily: "var(--font-sans)",
        }}
      >
        {limit && !showHarnessName ? (
          <UsageRing pct={limit.pct} accent={accent} />
        ) : (
          <HarnessDot accent={accent} />
        )}
        {showHarnessName && (
          <span style={{ color: CHIP_MUTED_COLOR, fontSize: 11 }}>{label}</span>
        )}
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            fontSize: 12,
            fontWeight: showHarnessName ? 650 : 600,
            color: "var(--fg-primary)",
            fontFamily:
              '"SF Mono", "Cascadia Mono", "Roboto Mono", ui-monospace, monospace',
          }}
        >
          {headline}
        </span>
      </button>
      {open && (
        <div className="aya-recent-menu" role="menu" style={{ width: RECENT_MENU_WIDTH_PX, padding: 12 }}>
          <div className="aya-recent-menu-title">{label} — account-wide</div>
          {limit && (
            <>
              <UsageRow label="week" win={limit} accent={accent} />
              <div style={{ color: CHIP_MUTED_COLOR, fontSize: 11, marginBottom: 10 }}>
                {updatedText(limit.updatedAt, stale)}
              </div>
            </>
          )}
          {usage.turns > 0 && (
            <>
              <div style={{ color: CHIP_MUTED_COLOR, fontSize: 12, marginBottom: 10 }}>
                Last {GROK_USAGE_WINDOW_DAYS} days, all sessions, not this project
              </div>
              {hasCost && row("Spend", fmtUsd(usage.costUsdTicks))}
              {row("Tokens", fmtTokens(usage.totalTokens))}
              {row("  Input", fmtTokens(usage.inputTokens))}
              {row("  Output", fmtTokens(usage.outputTokens))}
              {usage.cachedReadTokens > 0 && row("  Cache read", fmtTokens(usage.cachedReadTokens))}
              {usage.reasoningTokens > 0 && row("  Reasoning", fmtTokens(usage.reasoningTokens))}
              {row("Turns", `${usage.turns}`)}
            </>
          )}
          {(usage.models.length > 0 || !limit) && (
            <div
              style={{
                color: CHIP_MUTED_COLOR,
                fontSize: 11,
                marginTop: 10,
                borderTop: `1px solid ${CHIP_BORDER_COLOR}`,
                paddingTop: 8,
              }}
            >
              {usage.models.length > 0 ? usage.models.join(", ") : "Grok"}
              {!limit && " · no weekly limit logged by Grok yet"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
