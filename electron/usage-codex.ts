// Codex usage, read straight from Codex's own local session logs.
//
// Unlike the Claude path (which needs a hook to fetch from an endpoint), Codex
// writes its official rate-limit percentages INTO the local rollout JSONL — a
// `token_count` event carries a `rate_limits` object with the 5h ("primary")
// and weekly ("secondary") used-percent + reset times, and the line carries its
// own ISO `timestamp`. So Aya needs no token, no endpoint, no hook: it reads the
// newest rollout that actually has a snapshot. The result is the same shared
// UsageData shape the chip already renders.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageAccount, UsageData } from "./usage";
import { expandUserPath, usageAccountFromData } from "./usage";

/** The default Codex home — the env override, else ~/.codex. Additional homes
 *  (second accounts) are derived from preset commands and passed in explicitly. */
export const DEFAULT_CODEX_HOME =
  process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");

// Bound the per-poll work: only the few most-recent rollouts are read/parsed.
const MAX_ROLLOUTS_SCANNED = 20;

export interface CodexUsageSource {
  id: string;
  label: string;
  home: string;
}

function isoFromUnixSeconds(sec: unknown): string | undefined {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return undefined;
  const ms = sec * 1000;
  // ECMAScript Date range guard: a finite but absurd resets_at (corrupt
  // rollout line) would make toISOString throw RangeError, and that throw
  // propagates through the usage:get-codex IPC handler into an uncaught
  // rejection that silently stops the chip from refreshing (#93). An
  // out-of-range value means "no reset time", not a poisoned snapshot.
  if (Math.abs(ms) > 8.64e15) return undefined;
  return new Date(ms).toISOString();
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function accountMetaFromEvent(obj: {
  payload?: Record<string, unknown>;
}): { id: string; label: string } {
  const payload = obj.payload ?? {};
  const rl =
    typeof payload.rate_limits === "object" && payload.rate_limits !== null
      ? (payload.rate_limits as Record<string, unknown>)
      : {};
  const account =
    typeof payload.account === "object" && payload.account !== null
      ? (payload.account as Record<string, unknown>)
      : {};
  const id =
    firstString(
      rl.account_id,
      rl.accountId,
      rl.user_id,
      rl.userId,
      rl.email,
      payload.account_id,
      payload.accountId,
      payload.user_id,
      payload.userId,
      payload.email,
      account.id,
      account.account_id,
      account.user_id,
      account.email,
    ) ?? "default";
  const label =
    firstString(
      rl.account_label,
      rl.accountLabel,
      rl.account_name,
      rl.accountName,
      rl.email,
      payload.account_label,
      payload.accountLabel,
      payload.account_name,
      payload.accountName,
      payload.email,
      account.label,
      account.name,
      account.email,
    ) ?? (id === "default" ? "Account" : id);
  return { id, label };
}

// Windows at or below this length render as the "5h" ring; anything longer
// (the weekly 10080) is the "week" ring. Newer Codex schemas carry
// window_minutes per window; older ones didn't, so position is the fallback.
const SHORT_WINDOW_MAX_MINUTES = 600;

interface CodexRawWindow {
  used_percent?: unknown;
  resets_at?: unknown;
  window_minutes?: unknown;
}

/** Map Codex's rate_limits to UsageData. Historically this REQUIRED both
 *  `primary` and `secondary` windows - newer Codex plans set `secondary: null`
 *  and report a single weekly window in `primary` (window_minutes: 10080),
 *  which silently killed the chip. Now: every window that carries a finite
 *  used_percent is kept, classified by its own window_minutes (short -> 5h
 *  ring, long -> week ring; positional fallback when absent), and a snapshot
 *  with at least ONE valid window is a valid snapshot. */
export function codexUsageFromRateLimit(
  rl: unknown,
  updatedAtMs: number,
): UsageData | null {
  if (typeof rl !== "object" || rl === null) return null;
  const r = rl as { primary?: unknown; secondary?: unknown };

  const toWindow = (
    raw: unknown,
  ): { pct: number; resetsAt?: string; minutes?: number } | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const w = raw as CodexRawWindow;
    if (typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) {
      return null;
    }
    const minutes =
      typeof w.window_minutes === "number" && Number.isFinite(w.window_minutes)
        ? w.window_minutes
        : undefined;
    return {
      pct: w.used_percent,
      resetsAt: isoFromUnixSeconds(w.resets_at),
      minutes,
    };
  };

  const result: UsageData = { updatedAt: new Date(updatedAtMs).toISOString() };
  const positions: Array<"fiveHour" | "sevenDay"> = ["fiveHour", "sevenDay"];
  [r.primary, r.secondary].forEach((raw, i) => {
    const win = toWindow(raw);
    if (!win) return;
    const slot: "fiveHour" | "sevenDay" =
      win.minutes !== undefined
        ? win.minutes <= SHORT_WINDOW_MAX_MINUTES
          ? "fiveHour"
          : "sevenDay"
        : positions[i];
    // Slot conflict (two windows classifying to the same ring): DROP the
    // extra rather than relabeling it as the other ring - a silently
    // mislabeled limit is worse than an omitted one.
    if (result[slot] !== undefined) return;
    result[slot] = { pct: win.pct, resetsAt: win.resetsAt };
  });
  if (result.fiveHour === undefined && result.sevenDay === undefined) return null;
  return result;
}

/** Scan rollout JSONL lines (oldest→newest) and return UsageData from the LAST
 *  line that yields a complete snapshot. Uses that line's own ISO `timestamp`
 *  for updatedAt when present, else `fallbackMs` (the file mtime). Lines with no
 *  rate_limits, an incomplete one, or malformed JSON are skipped — so a trailing
 *  non-snapshot event doesn't hide an earlier valid one in the same file. */
export function latestUsageFromLines(
  lines: string[],
  fallbackMs: number,
): UsageData | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let obj: { timestamp?: unknown; payload?: { rate_limits?: unknown } };
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const rl = obj?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const tsMs =
      typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    const usage = codexUsageFromRateLimit(
      rl,
      Number.isFinite(tsMs) ? tsMs : fallbackMs,
    );
    if (usage) return usage;
  }
  return null;
}

export function latestUsageAccountsFromLines(
  lines: string[],
  fallbackMs: number,
): UsageAccount[] {
  const byId = new Map<string, UsageAccount>();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let obj: { timestamp?: unknown; payload?: Record<string, unknown> };
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const rl = obj?.payload?.rate_limits;
    if (!rl || typeof rl !== "object") continue;
    const tsMs =
      typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    const usage = codexUsageFromRateLimit(
      rl,
      Number.isFinite(tsMs) ? tsMs : fallbackMs,
    );
    if (!usage) continue;
    const meta = accountMetaFromEvent(obj);
    if (!byId.has(meta.id)) {
      byId.set(meta.id, usageAccountFromData(usage, meta.id, meta.label));
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---- Poll-to-poll caches ---------------------------------------------------
//
// The renderer polls usage every 30s. Without caching, each poll re-walks the
// whole sharded sessions tree (readdir per YYYY/MM/DD dir), re-stats every
// rollout in history and re-reads + re-parses up to 20 full JSONL files per
// source. Rollouts can be megabytes, so the parse is the dominant cost. The
// caches below make a steady-state poll cost roughly one stat per directory
// plus one stat per candidate file, and zero reads/parses.

// Recover exotic mtime changes (e.g. resuming a months-old session appends to
// its old rollout without touching any directory mtime) by re-statting every
// file periodically instead of every poll.
const FULL_STAT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

interface DirCacheEntry {
  mtimeMs: number;
  subdirs: string[];
  /** rollout-*.jsonl basenames in this dir. */
  files: string[];
}

interface WalkCache {
  /** readdir results, keyed by dir path + gated on the dir's mtime. A dir's
   *  mtime changes whenever an entry is added/removed, so NEW rollout files
   *  (and new day-dirs) are always discovered within one poll. */
  dirs: Map<string, DirCacheEntry>;
  /** Last observed mtime per rollout file. */
  fileMtimes: Map<string, number>;
  /** The candidates returned last poll. Appending to a file does NOT bump its
   *  parent dir's mtime, so the active rollouts (which are by definition the
   *  newest) are re-statted every poll to notice fresh snapshots. */
  hotFiles: Set<string>;
  lastFullSweepMs: number;
}

// Keyed by expanded sessions root, so multiple CODEX_HOME sources don't mix.
const walkCaches = new Map<string, WalkCache>();

interface ParsedRollout {
  mtimeMs: number;
  usage: UsageData | null;
  accounts: UsageAccount[];
}

// Parsed usage per rollout file, keyed by path + gated on mtime. Bounded: the
// walk prunes entries that fall out of a source's newest-N candidate list.
const rolloutParseCache = new Map<string, ParsedRollout>();

/** Test hook: forget everything cached between polls. */
export function resetCodexUsageCaches(): void {
  walkCaches.clear();
  rolloutParseCache.clear();
}

/** The most-recently-modified rollout files under ~/.codex/sessions, newest
 *  first, capped — so an old session that just hasn't emitted a snapshot yet
 *  doesn't sink the chip, without reading the whole history every poll. */
async function recentRolloutFiles(
  home = DEFAULT_CODEX_HOME,
): Promise<{ file: string; mtimeMs: number }[]> {
  const root = path.join(expandUserPath(home), "sessions");
  let cache = walkCaches.get(root);
  if (!cache) {
    cache = {
      dirs: new Map(),
      fileMtimes: new Map(),
      hotFiles: new Set(),
      lastFullSweepMs: 0,
    };
    walkCaches.set(root, cache);
  }
  const now = Date.now();
  const fullSweep = now - cache.lastFullSweepMs >= FULL_STAT_SWEEP_INTERVAL_MS;
  if (fullSweep) cache.lastFullSweepMs = now;

  const seenDirs = new Set<string>();
  const seenFiles = new Set<string>();
  const found: { file: string; mtimeMs: number }[] = [];

  async function statFile(full: string, force: boolean): Promise<void> {
    const cached = cache!.fileMtimes.get(full);
    if (cached !== undefined && !force) {
      found.push({ file: full, mtimeMs: cached });
      return;
    }
    try {
      const st = await fs.stat(full);
      cache!.fileMtimes.set(full, st.mtimeMs);
      found.push({ file: full, mtimeMs: st.mtimeMs });
    } catch {
      // Vanished between readdir and stat.
      cache!.fileMtimes.delete(full);
    }
  }

  async function walk(dir: string): Promise<void> {
    seenDirs.add(dir);
    let dirStat: import("node:fs").Stats;
    try {
      dirStat = await fs.stat(dir);
    } catch {
      cache!.dirs.delete(dir);
      return;
    }
    let entry = cache!.dirs.get(dir);
    if (!entry || entry.mtimeMs !== dirStat.mtimeMs) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        cache!.dirs.delete(dir);
        return;
      }
      entry = { mtimeMs: dirStat.mtimeMs, subdirs: [], files: [] };
      for (const e of entries) {
        if (e.isDirectory()) {
          entry.subdirs.push(e.name);
        } else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
          entry.files.push(e.name);
        }
      }
      cache!.dirs.set(dir, entry);
    }
    for (const name of entry.subdirs) await walk(path.join(dir, name));
    for (const name of entry.files) {
      const full = path.join(dir, name);
      seenFiles.add(full);
      await statFile(full, fullSweep || cache!.hotFiles.has(full));
    }
  }
  await walk(root);

  // Drop cache entries for dirs/files that disappeared from the tree.
  for (const dir of cache.dirs.keys()) {
    if (!seenDirs.has(dir)) cache.dirs.delete(dir);
  }
  for (const file of cache.fileMtimes.keys()) {
    if (!seenFiles.has(file)) {
      cache.fileMtimes.delete(file);
      rolloutParseCache.delete(file);
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = found.slice(0, MAX_ROLLOUTS_SCANNED);
  cache.hotFiles = new Set(top.map((f) => f.file));

  // Bound the parse cache: keep only this source's current candidates.
  for (const file of rolloutParseCache.keys()) {
    if (file.startsWith(root + path.sep) && !cache.hotFiles.has(file)) {
      rolloutParseCache.delete(file);
    }
  }
  return top;
}

/** Read + parse a rollout, or reuse the cached parse when its mtime hasn't
 *  moved. Both the single-usage and per-account results are derived in one
 *  pass so either caller warms the cache for the other. */
async function parseRollout(
  file: string,
  mtimeMs: number,
): Promise<ParsedRollout | null> {
  const cached = rolloutParseCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const parsed: ParsedRollout = {
    mtimeMs,
    usage: latestUsageFromLines(lines, mtimeMs),
    accounts: latestUsageAccountsFromLines(lines, mtimeMs),
  };
  rolloutParseCache.set(file, parsed);
  return parsed;
}

/** Read Codex's account-wide usage from its newest rollout that carries a
 *  snapshot. Returns null if Codex isn't present or none of the recent rollouts
 *  has a rate-limit event yet. */
export async function readCodexUsage(): Promise<UsageData | null> {
  for (const f of await recentRolloutFiles()) {
    const parsed = await parseRollout(f.file, f.mtimeMs);
    if (parsed?.usage) return parsed.usage;
  }
  return null;
}

/** Read all Codex account-wide usage snapshots discoverable in recent rollouts.
 *  When Codex logs do not expose an account id, this returns at most one
 *  "Account" entry, preserving the previous single-chip behavior. */
export async function readCodexUsageAccounts(): Promise<UsageAccount[]> {
  return readCodexUsageAccountsFromSources([
    { id: "codex", label: "Codex", home: DEFAULT_CODEX_HOME },
  ]);
}

export async function readCodexUsageAccountsFromSources(
  sources: CodexUsageSource[],
): Promise<UsageAccount[]> {
  const byId = new Map<string, UsageAccount>();
  for (const source of sources) {
    for (const f of await recentRolloutFiles(source.home)) {
      const parsed = await parseRollout(f.file, f.mtimeMs);
      if (!parsed) continue;
      for (const account of parsed.accounts) {
        const normalized =
          account.id === "default"
            ? { ...account, id: source.id, label: source.label }
            : account;
        if (!byId.has(normalized.id)) byId.set(normalized.id, normalized);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}
