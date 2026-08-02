// Account-wide Claude/Codex usage snapshot.
//
// Aya does NOT fetch this — it only reads a small JSON file that a
// user-configured Claude Code hook writes (the hook curls the usage endpoint
// with the user's own token and persists the result; see docs). Aya core holds
// zero endpoint/token logic, so it stays a plain file reader.
//
// The numbers are ACCOUNT-WIDE (all sessions / devices share the 5h + weekly
// limits) — never per-project or per-terminal. The UI labels them as such.

import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { USAGE_FILE } from "./paths";

export interface UsageWindow {
  /** Percent of this limit window already used (0–100+). */
  pct: number;
  /** ISO 8601 time this window resets, if the hook provided it. */
  resetsAt?: string;
}

export interface UsageData {
  /** Rolling 5-hour window. Optional: newer Codex plans expose only a single
   *  (weekly) window, so a snapshot may carry either ring alone. */
  fiveHour?: UsageWindow;
  /** Rolling 7-day (weekly) window — the account-wide cap. Optional, see above. */
  sevenDay?: UsageWindow;
  /** ISO 8601 time the hook last wrote this snapshot. */
  updatedAt: string;
}

export interface UsageAccount {
  id: string;
  label: string;
  usage: UsageData;
}

function isWindow(x: unknown): x is UsageWindow {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r.pct !== "number" || !Number.isFinite(r.pct) || r.pct < 0) {
    return false;
  }
  if (r.resetsAt !== undefined && typeof r.resetsAt !== "string") return false;
  return true;
}

export function isUsageData(x: unknown): x is UsageData {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  // At least one window must be present, and every present window must be
  // well-formed. (Newer Codex plans report a single weekly window; Claude's
  // hook always writes both - both shapes are valid snapshots.)
  return (
    typeof r.updatedAt === "string" &&
    (r.fiveHour !== undefined || r.sevenDay !== undefined) &&
    (r.fiveHour === undefined || isWindow(r.fiveHour)) &&
    (r.sevenDay === undefined || isWindow(r.sevenDay))
  );
}

export function isUsageAccount(x: unknown): x is UsageAccount {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.trim().length > 0 &&
    typeof r.label === "string" &&
    r.label.trim().length > 0 &&
    isUsageData(r.usage)
  );
}

export function usageAccountFromData(
  usage: UsageData,
  id = "default",
  label = "Account",
): UsageAccount {
  return { id, label, usage };
}

export interface ClaudeUsageSource {
  id: string;
  label: string;
  configDir: string;
}

export function expandUserPath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (value.startsWith("$HOME/")) return path.join(os.homedir(), value.slice(6));
  return path.resolve(value);
}

export function claudeUsageFileForConfigDir(configDir: string): string {
  const expanded = expandUserPath(configDir);
  const hash = crypto.createHash("sha256").update(expanded).digest("hex");
  return path.join(path.dirname(USAGE_FILE), `usage-claude-${hash}.json`);
}

/** Parse + validate the raw file contents. Returns null on ANY problem
 *  (malformed JSON, wrong shape) so a stale or hand-broken file can never
 *  crash Aya or mis-render the chip — it just hides. */
export function parseUsage(raw: string): UsageData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isUsageData(parsed) ? parsed : null;
}

/** Parse either the original single-account shape or the multi-account shape:
 *  `{ accounts: [{ id, label, usage }] }`. Invalid accounts are ignored; a file
 *  with no valid accounts hides the chips. Duplicate ids keep the first
 *  occurrence so the renderer never sees colliding React keys. */
export function parseUsageAccounts(raw: string): UsageAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (isUsageData(parsed)) return [usageAccountFromData(parsed)];
  if (typeof parsed !== "object" || parsed === null) return [];
  const accounts = (parsed as Record<string, unknown>).accounts;
  if (!Array.isArray(accounts)) return [];
  const seen = new Set<string>();
  const out: UsageAccount[] = [];
  for (const a of accounts) {
    if (!isUsageAccount(a) || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

// Poll-path caches: the usage chip polls every 30s but the hook rewrites these
// files far less often, so a stat (cheap) gates the read+parse (not). Parsed
// results — including null/[] for a broken file — are reused until the mtime
// moves. Entries are dropped when a file disappears; the key space is bounded
// by the number of configured sources.
interface CachedParse<T> {
  mtimeMs: number;
  value: T;
}
const usageDataCache = new Map<string, CachedParse<UsageData | null>>();
const usageAccountsCache = new Map<string, CachedParse<UsageAccount[]>>();

/** Test hook: forget all cached usage-file parses. */
export function resetUsageFileCaches(): void {
  usageDataCache.clear();
  usageAccountsCache.clear();
}

/** stat-gated read+parse. Returns undefined when the file is unreadable. */
async function readParsed<T>(
  file: string,
  cache: Map<string, CachedParse<T>>,
  parse: (raw: string) => T,
): Promise<T | undefined> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
  } catch {
    cache.delete(file);
    return undefined;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    cache.delete(file);
    return undefined;
  }
  const value = parse(raw);
  cache.set(file, { mtimeMs, value });
  return value;
}

/** Read one or more usage snapshots the user's hook writes. Never fetches. */
export async function readUsageAccounts(): Promise<UsageAccount[]> {
  const accounts = await readParsed(
    USAGE_FILE,
    usageAccountsCache,
    parseUsageAccounts,
  );
  return accounts ? [...accounts] : [];
}

export async function readClaudeUsageAccounts(
  sources: ClaudeUsageSource[],
): Promise<UsageAccount[]> {
  if (sources.length === 0) return readUsageAccounts();

  const out: UsageAccount[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const configDir = expandUserPath(source.configDir);
    const files = [claudeUsageFileForConfigDir(configDir)];
    if (configDir === path.join(os.homedir(), ".claude")) files.push(USAGE_FILE);

    let usage: UsageData | null = null;
    for (const file of files) {
      usage = (await readParsed(file, usageDataCache, parseUsage)) ?? null;
      if (usage) break;
    }
    if (!usage || seen.has(source.id)) continue;
    seen.add(source.id);
    out.push(usageAccountFromData(usage, source.id, source.label));
  }
  return out;
}
