// Grok usage, read from its own local session logs.
//
// Unlike Claude (a user hook writes percentages) and Codex (its rollouts carry
// rate-limit percentages), the Grok Build CLI records NO rate-limit % or reset
// locally - only a per-turn token + cost breakdown in
// ~/.grok/sessions/<enc-cwd>/<uuid>/updates.jsonl. Grok's weekly pool lives
// server-side and is never written to disk. So Aya cannot show a "% of limit"
// ring for Grok; it shows what IS local and account-wide: tokens and cost used
// over a rolling 7-day window, summed across every session. Read-only: no token,
// no endpoint, no fetch - same as the Codex path.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandUserPath } from "./usage";

/** The default Grok home - the env override, else ~/.grok. */
export const DEFAULT_GROK_HOME =
  process.env.GROK_HOME && process.env.GROK_HOME.trim()
    ? path.resolve(process.env.GROK_HOME)
    : path.join(os.homedir(), ".grok");

/** Rolling window the chip sums over. Grok's paid pool is weekly; 7 days is the
 *  honest local proxy (we don't know the server-side reset boundary). */
export const GROK_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Aggregated Grok usage over the window, account-wide across all sessions. */
export interface GrokUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Cost in Grok's own unit: 1e-10 USD ("ticks"). USD = ticks * 1e-10. */
  costUsdTicks: number;
  /** Completed turns counted. */
  turns: number;
  /** Distinct model ids seen, sorted. */
  models: string[];
  /** ISO time of the newest turn counted. Stable between polls (unlike "now"),
   *  so an unchanged week doesn't churn the renderer. */
  updatedAt: string;
}

/** One turn's usage, extracted from a log line. Pure, exported for tests. The
 *  Grok CLI's updates.jsonl is JSON-RPC framed: the turn total lives at
 *  params.update.usage on a turn-completed line, with the event time at
 *  params._meta.agentTimestampMs (else the top-level `timestamp`). */
export interface GrokUsageRow {
  tsMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsdTicks: number;
  models: string[];
}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** ms-epoch from a value that may be seconds or milliseconds. */
function toMs(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return x < 1e12 ? x * 1000 : x;
}

/** Pull a usage row from one JSONL line, or null if it carries no turn usage.
 *  Only lines with a `params.update.usage` object bearing token counts count. */
export function extractGrokUsageRow(line: string): GrokUsageRow | null {
  // Cheap prefilter: skip the vast majority of lines (tool calls, content)
  // without paying for a JSON.parse.
  if (!line.includes('"usage"')) return null;
  let obj: {
    timestamp?: unknown;
    params?: {
      update?: { usage?: Record<string, unknown> };
      _meta?: { agentTimestampMs?: unknown };
    };
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = obj?.params?.update?.usage;
  if (typeof usage !== "object" || usage === null) return null;
  // A usage object must carry at least a token total to be a real turn row.
  const total = num(usage.totalTokens);
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  if (total === 0 && input === 0 && output === 0) return null;
  const tsMs =
    toMs(obj.params?._meta?.agentTimestampMs) ?? toMs(obj.timestamp) ?? 0;
  const modelUsage = usage.modelUsage;
  const models =
    typeof modelUsage === "object" && modelUsage !== null
      ? Object.keys(modelUsage as Record<string, unknown>)
      : [];
  return {
    tsMs,
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: num(usage.cachedReadTokens),
    cacheCreationTokens: num(usage.cacheCreationTokens),
    reasoningTokens: num(usage.reasoningTokens),
    totalTokens: total || input + output,
    costUsdTicks: num(usage.costUsdTicks),
    models,
  };
}

/** Sum the rows that fall inside [nowMs - windowMs, nowMs]. Pure, tested. */
export function sumGrokUsage(
  rows: GrokUsageRow[],
  nowMs: number,
  windowMs: number = GROK_USAGE_WINDOW_MS,
): GrokUsage | null {
  const sinceMs = nowMs - windowMs;
  const acc: GrokUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsdTicks: 0,
    turns: 0,
    models: [],
    updatedAt: "",
  };
  const models = new Set<string>();
  let maxTs = 0;
  for (const r of rows) {
    if (r.tsMs < sinceMs || r.tsMs > nowMs) continue;
    acc.inputTokens += r.inputTokens;
    acc.outputTokens += r.outputTokens;
    acc.cachedReadTokens += r.cachedReadTokens;
    acc.cacheCreationTokens += r.cacheCreationTokens;
    acc.reasoningTokens += r.reasoningTokens;
    acc.totalTokens += r.totalTokens;
    acc.costUsdTicks += r.costUsdTicks;
    acc.turns += 1;
    if (r.tsMs > maxTs) maxTs = r.tsMs;
    for (const m of r.models) models.add(m);
  }
  if (acc.turns === 0) return null;
  acc.models = [...models].sort();
  acc.updatedAt = new Date(maxTs).toISOString();
  return acc;
}

// ---- fs scan (mtime-gated per-file cache) ----------------------------------
// The renderer polls every 30s; a file's extracted rows only change when it is
// appended (which moves its mtime), so parse is gated on mtime and the rolling
// window is re-applied to cached rows cheaply each poll.

interface CachedRows {
  mtimeMs: number;
  rows: GrokUsageRow[];
}
const rowCache = new Map<string, CachedRows>();

/** Test hook: forget cached per-file parses. */
export function resetGrokUsageCache(): void {
  rowCache.clear();
}

/** updates.jsonl paths under a grok home whose file mtime is within the window
 *  (older files can't hold in-window rows: appending would have moved mtime). */
async function recentSessionLogs(
  home: string,
  sinceMs: number,
): Promise<string[]> {
  const sessions = path.join(expandUserPath(home), "sessions");
  const out: string[] = [];
  let cwds: string[];
  try {
    cwds = await fs.readdir(sessions);
  } catch {
    return out;
  }
  for (const cwd of cwds) {
    const cwdDir = path.join(sessions, cwd);
    let uuids: string[];
    try {
      uuids = await fs.readdir(cwdDir);
    } catch {
      continue;
    }
    for (const uuid of uuids) {
      const file = path.join(cwdDir, uuid, "updates.jsonl");
      try {
        const st = await fs.stat(file);
        if (st.isFile() && st.mtimeMs >= sinceMs) out.push(file);
      } catch {
        // not a session dir / no log
      }
    }
  }
  return out;
}

async function rowsForFile(file: string): Promise<GrokUsageRow[]> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    rowCache.delete(file);
    return [];
  }
  const cached = rowCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.rows;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    rowCache.delete(file);
    return [];
  }
  const rows: GrokUsageRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const row = extractGrokUsageRow(line);
    if (row) rows.push(row);
  }
  rowCache.set(file, { mtimeMs, rows });
  return rows;
}

/** Aggregate Grok usage over the rolling window across every session under the
 *  given homes (deduped by resolved path). null when there is nothing in the
 *  window - the chip then hides. */
export async function readGrokUsage(
  homes: string[] = [DEFAULT_GROK_HOME],
  nowMs: number = Date.now(),
): Promise<GrokUsage | null> {
  const sinceMs = nowMs - GROK_USAGE_WINDOW_MS;
  const seen = new Set<string>();
  const allRows: GrokUsageRow[] = [];
  for (const home of homes.length > 0 ? homes : [DEFAULT_GROK_HOME]) {
    for (const file of await recentSessionLogs(home, sinceMs)) {
      if (seen.has(file)) continue;
      seen.add(file);
      allRows.push(...(await rowsForFile(file)));
    }
  }
  return sumGrokUsage(allRows, nowMs);
}
