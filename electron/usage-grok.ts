// Read-only (no token, no endpoint): spend and tokens from session logs, the
// weekly limit % from the credits line Grok 1.0.41+ writes to logs/unified.jsonl.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandUserPath } from "./usage";
import { readBufferAtMost, scanJsonlTail } from "./bounded-file-read";

/** The default Grok home - the env override, else ~/.grok. */
export const DEFAULT_GROK_HOME =
  process.env.GROK_HOME && process.env.GROK_HOME.trim()
    ? path.resolve(process.env.GROK_HOME)
    : path.join(os.homedir(), ".grok");

/** Rolling window the chip sums over. Grok's paid pool is weekly; 7 days is the
 *  honest local proxy (we don't know the server-side reset boundary). */
export const GROK_USAGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-session hard limit: only the newest bounded tail is parsed. */
export const GROK_SESSION_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const MAX_GROK_SESSION_FILES = 256;
const MAX_GROK_ROWS_PER_FILE = 2000;
const MAX_GROK_TOTAL_ROWS = 20_000;
const MAX_GROK_TOTAL_ROW_BYTES = 16 * 1024 * 1024;
const MAX_GROK_ROW_CACHE_BYTES = 32 * 1024 * 1024;
export const GROK_LIMIT_PARTIAL_MAX_BYTES = 1024 * 1024;
export const GROK_USAGE_TOTAL_SCAN_MAX_BYTES = 64 * 1024 * 1024;
// Grok bills in ticks of 1e-10 USD (GrokUsage.costUsdTicks).
export const USD_PER_GROK_TICK = 1e-10;
// Epoch values below this are seconds (1e12 ms is 2001; 1e12 s is year 33658).
export const SECONDS_EPOCH_CEILING = 1e12;

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
  limit?: GrokLimit;
}

export interface GrokLimit {
  pct: number;
  resetsAt: string;
  /** When Grok logged it; Grok logs it irregularly, so it can be old. */
  updatedAt: string;
}

const CREDITS_MSG = "billing: fetched credits config";

const isIsoTime = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

/** Null for any other line, or one whose shape is not what 1.0.41 logs. */
export function extractGrokLimit(line: string): GrokLimit | null {
  if (!line.includes(CREDITS_MSG)) return null;
  let entry: {
    msg?: unknown;
    ts?: unknown;
    ctx?: { config?: { creditUsagePercent?: unknown; currentPeriod?: { end?: unknown } } };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const config = entry.ctx?.config;
  const pct = config?.creditUsagePercent;
  const end = config?.currentPeriod?.end;
  if (entry.msg !== CREDITS_MSG || typeof pct !== "number" || !Number.isFinite(pct)) return null;
  if (!isIsoTime(end) || !isIsoTime(entry.ts)) return null;
  return { pct, resetsAt: end, updatedAt: entry.ts };
}

// Grok can go a day between credits lines while the log grows ~200 KB/h, so a
// fixed tail loses the line; read the append-only log incrementally instead.
interface LimitScan {
  ino: number;
  size: number;
  partial: string;
  discardUntilNewline: boolean;
  limit: GrokLimit | null;
}
const limitScans = new Map<string, LimitScan>();

/** Per-file ceiling for unified.jsonl. Its bytes also count against the shared
 *  GROK_USAGE_TOTAL_SCAN_MAX_BYTES poll budget used by session transcripts. */
export const GROK_LIMIT_SCAN_MAX_BYTES = 32 * 1024 * 1024;

/** Where to start reading: from `from`, unless that leaves more than `max`
 *  bytes, then the tail - flagging that the first line may be cut. Pure. */
export function limitScanWindow(
  from: number,
  size: number,
  max: number = GROK_LIMIT_SCAN_MAX_BYTES,
): { start: number; cut: boolean } {
  return size - from > max ? { start: size - max, cut: true } : { start: from, cut: false };
}

async function newestLoggedLimit(
  file: string,
  maxBytes = GROK_LIMIT_SCAN_MAX_BYTES,
): Promise<{ limit: GrokLimit | null; bytesRead: number }> {
  const known = limitScans.get(file);
  if (maxBytes <= 0) return { limit: known?.limit ?? null, bytesRead: 0 };
  let scan: LimitScan;
  let chunk: string;
  let bytesRead = 0;
  try {
    const handle = await fs.open(file, "r");
    try {
      const { ino, size } = await handle.stat();
      // Another file, or shorter than what was read: rotated or truncated.
      const fresh = !known || known.ino !== ino || size < known.size;
      scan = fresh ? { ino, size: 0, partial: "", discardUntilNewline: false, limit: null } : known;
      const { start, cut } = limitScanWindow(scan.size, size, Math.min(maxBytes, GROK_LIMIT_SCAN_MAX_BYTES));
      const buffer = Buffer.alloc(size - start);
      const readResult = await readBufferAtMost(
        (target, offset, length, position) => handle.read(target, offset, length, position),
        buffer,
        buffer.length,
        start,
      );
      bytesRead = readResult.bytesRead;
      chunk = buffer.toString("utf-8", 0, bytesRead);
      let discardUntilNewline = scan.discardUntilNewline;
      if (cut) {
        // Started mid-file: the carried partial belongs to skipped bytes, and
        // the first line read is probably cut too - drop both.
        const nl = chunk.indexOf("\n");
        chunk = nl === -1 ? "" : chunk.slice(nl + 1);
        scan = { ...scan, partial: "" };
        discardUntilNewline = nl === -1;
      }
      scan = { ...scan, size: start + bytesRead, discardUntilNewline };
    } finally {
      await handle.close();
    }
  } catch {
    // A passing read error keeps the last known limit instead of blanking it.
    return { limit: known?.limit ?? null, bytesRead: 0 };
  }
  let input = scan.partial + chunk;
  let discardUntilNewline = scan.discardUntilNewline;
  if (discardUntilNewline) {
    const newline = input.indexOf("\n");
    if (newline < 0) {
      limitScans.set(file, { ...scan, partial: "", discardUntilNewline: true });
      return { limit: scan.limit, bytesRead };
    }
    input = input.slice(newline + 1);
    discardUntilNewline = false;
  }
  let limit = scan.limit;
  let lineStart = 0;
  let newline = input.indexOf("\n", lineStart);
  while (newline >= 0) {
    limit = extractGrokLimit(input.slice(lineStart, newline)) ?? limit;
    lineStart = newline + 1;
    newline = input.indexOf("\n", lineStart);
  }
  const partial = input.slice(lineStart);
  const keepPartial = Buffer.byteLength(partial, "utf8") <= GROK_LIMIT_PARTIAL_MAX_BYTES;
  limitScans.set(file, {
    ...scan,
    partial: keepPartial ? partial : "",
    discardUntilNewline: discardUntilNewline || !keepPartial,
    limit,
  });
  return { limit, bytesRead };
}

/** The newest logged limit, or null when none is found or its week is over
 *  (last week's % says nothing about this one). */
export async function readGrokLimit(
  home: string,
  nowMs: number = Date.now(),
  maxBytes: number = GROK_LIMIT_SCAN_MAX_BYTES,
): Promise<GrokLimit | null> {
  const result = await newestLoggedLimit(path.join(expandUserPath(home), "logs", "unified.jsonl"), maxBytes);
  const limit = result.limit;
  return limit && Date.parse(limit.resetsAt) > nowMs ? limit : null;
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
  return x < SECONDS_EPOCH_CEILING ? x * 1000 : x;
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
          .slice(0, 8)
          .map((model) => model.slice(0, 128))
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

function emptyGrokUsage(updatedAt: string): GrokUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsdTicks: 0,
    turns: 0,
    models: [],
    updatedAt,
  };
}

/** Sum the rows that fall inside [nowMs - windowMs, nowMs]. Pure, tested. */
export function sumGrokUsage(
  rows: GrokUsageRow[],
  nowMs: number,
  windowMs: number = GROK_USAGE_WINDOW_MS,
): GrokUsage | null {
  const sinceMs = nowMs - windowMs;
  const acc = emptyGrokUsage("");
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
  ino: number;
  size: number;
  rows: GrokUsageRow[];
}
const rowCache = new Map<string, CachedRows>();
let rowCacheBytes = 0;

/** Test hook: forget cached per-file parses. */
export function resetGrokUsageCache(): void {
  rowCache.clear();
  rowCacheBytes = 0;
  limitScans.clear();
}

function grokRowsWeight(rows: GrokUsageRow[]): number {
  return rows.reduce(
    (total, row) => total + 96 + row.models.reduce((n, model) => n + model.length * 2, 0),
    0,
  );
}

function grokRowKey(row: GrokUsageRow): string {
  return JSON.stringify([
    row.tsMs,
    row.inputTokens,
    row.outputTokens,
    row.cachedReadTokens,
    row.cacheCreationTokens,
    row.reasoningTokens,
    row.totalTokens,
    row.costUsdTicks,
    row.models,
  ]);
}

/** updates.jsonl paths under a grok home whose file mtime is within the window
 *  (older files can't hold in-window rows: appending would have moved mtime). */
async function recentSessionLogs(
  home: string,
  sinceMs: number,
): Promise<Array<{ file: string; mtimeMs: number }>> {
  const sessions = path.join(expandUserPath(home), "sessions");
  const out: Array<{ file: string; mtimeMs: number }> = [];
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
        if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ file, mtimeMs: st.mtimeMs });
      } catch {
        // not a session dir / no log
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, MAX_GROK_SESSION_FILES);
}

async function rowsForFile(
  file: string,
  sinceMs: number,
  nowMs: number,
  maxBytes: number,
): Promise<{ rows: GrokUsageRow[]; bytesRead: number }> {
  let mtimeMs: number;
  let ino: number;
  let size: number;
  try {
    const st = await fs.stat(file);
    mtimeMs = st.mtimeMs;
    ino = st.ino;
    size = st.size;
  } catch {
    const old = rowCache.get(file);
    if (old) rowCacheBytes -= grokRowsWeight(old.rows);
    rowCache.delete(file);
    return { rows: [], bytesRead: 0 };
  }
  const cached = rowCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.ino === ino) {
    rowCache.delete(file);
    rowCache.set(file, cached);
    return {
      rows: cached.rows.filter((row) => row.tsMs >= sinceMs && row.tsMs <= nowMs),
      bytesRead: 0,
    };
  }
  const rows: GrokUsageRow[] = [];
  let bytesRead = 0;
  try {
    const scan = await scanJsonlTail(file, (line) => {
      if (!line.includes('"usage"')) return;
      const row = extractGrokUsageRow(line);
      if (!row) return;
      if (row.tsMs < sinceMs || row.tsMs > nowMs) return;
      rows.push(row);
      return rows.length >= MAX_GROK_ROWS_PER_FILE;
    }, { maxBytes: Math.min(GROK_SESSION_TAIL_MAX_BYTES, maxBytes) });
    bytesRead = scan.bytesRead;
  } catch {
    const old = rowCache.get(file);
    if (old) rowCacheBytes -= grokRowsWeight(old.rows);
    rowCache.delete(file);
    return { rows: [], bytesRead };
  }
  const old = rowCache.get(file);
  const grewInPlace = old && old.ino === ino && size > old.size;
  const mergedRows: GrokUsageRow[] = [];
  const rowKeys = new Set<string>();
  for (const row of [...rows, ...(grewInPlace ? old.rows : [])]) {
    if (row.tsMs < sinceMs || row.tsMs > nowMs) continue;
    const key = grokRowKey(row);
    if (rowKeys.has(key)) continue;
    rowKeys.add(key);
    mergedRows.push(row);
    if (mergedRows.length >= MAX_GROK_TOTAL_ROWS) break;
  }
  const weight = grokRowsWeight(mergedRows);
  // A reduced aggregate budget is a partial view, not a complete parse for
  // this file. Keep its older cache intact for the next poll, while returning
  // the merged view for this one result.
  if (maxBytes < GROK_SESSION_TAIL_MAX_BYTES || weight > MAX_GROK_ROW_CACHE_BYTES) {
    return { rows: mergedRows, bytesRead };
  }
  if (old) rowCacheBytes -= grokRowsWeight(old.rows);
  rowCache.delete(file);
  rowCache.set(file, { mtimeMs, ino, size, rows: mergedRows });
  rowCacheBytes += weight;
  while (rowCacheBytes > MAX_GROK_ROW_CACHE_BYTES || rowCache.size > MAX_GROK_SESSION_FILES) {
    const oldest = rowCache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = rowCache.get(oldest);
    rowCache.delete(oldest);
    if (evicted) rowCacheBytes -= grokRowsWeight(evicted.rows);
  }
  return { rows: mergedRows, bytesRead };
}

/** Whether `a` was logged after `b`, by time: the log's ts strings may differ in offset or milliseconds, and a
 *  string comparison then ranks them wrong ("...19:48:33Z" sorts after "...19:48:33.830Z"). */
function loggedAfter(a: GrokLimit, b: GrokLimit): boolean {
  return Date.parse(a.updatedAt) > Date.parse(b.updatedAt);
}

/** Aggregate Grok usage over the rolling window across every session under the
 *  given homes (deduped by real path, so a home given twice, or once through a
 *  symlink, counts once). null when there is nothing in the window - the chip
 *  then hides. */
export async function readGrokUsage(
  homes: string[] = [DEFAULT_GROK_HOME],
  nowMs: number = Date.now(),
): Promise<GrokUsage | null> {
  const sinceMs = nowMs - GROK_USAGE_WINDOW_MS;
  const seen = new Set<string>();
  const allRows: GrokUsageRow[] = [];
  let allRowsWeight = 0;
  let totalScanBytes = 0;
  let limit: GrokLimit | null = null;
  for (const home of homes.length > 0 ? homes : [DEFAULT_GROK_HOME]) {
    for (const candidate of await recentSessionLogs(home, sinceMs)) {
      if (
        allRows.length >= MAX_GROK_TOTAL_ROWS ||
        allRowsWeight >= MAX_GROK_TOTAL_ROW_BYTES
      ) break;
      // Read and cached under the real path too: a symlink retargeted to another log with the same mtime must not
      // get the old log's cached rows.
      const real = await fs.realpath(candidate.file).catch(() => candidate.file);
      if (seen.has(real)) continue;
      seen.add(real);
      const result = await rowsForFile(
        real,
        sinceMs,
        nowMs,
        Math.max(0, GROK_USAGE_TOTAL_SCAN_MAX_BYTES - totalScanBytes),
      );
      totalScanBytes += result.bytesRead;
      for (const row of result.rows) {
        const weight = 96 + row.models.reduce((n, model) => n + model.length * 2, 0);
        if (
          allRows.length >= MAX_GROK_TOTAL_ROWS ||
          allRowsWeight + weight > MAX_GROK_TOTAL_ROW_BYTES
        ) break;
        allRows.push(row);
        allRowsWeight += weight;
      }
    }
    const limitScan = await newestLoggedLimit(
      path.join(expandUserPath(home), "logs", "unified.jsonl"),
      Math.max(0, GROK_USAGE_TOTAL_SCAN_MAX_BYTES - totalScanBytes),
    );
    totalScanBytes += limitScan.bytesRead;
    const found = limitScan.limit && Date.parse(limitScan.limit.resetsAt) > nowMs
      ? limitScan.limit
      : null;
    if (found && (!limit || loggedAfter(found, limit))) limit = found;
  }
  const usage = sumGrokUsage(allRows, nowMs);
  if (!limit) return usage;
  return { ...(usage ?? emptyGrokUsage(limit.updatedAt)), limit };
}
