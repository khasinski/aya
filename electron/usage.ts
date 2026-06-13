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
import { USAGE_FILE } from "./paths";

export interface UsageWindow {
  /** Percent of this limit window already used (0–100+). */
  pct: number;
  /** ISO 8601 time this window resets, if the hook provided it. */
  resetsAt?: string;
}

export interface UsageData {
  /** Rolling 5-hour window. */
  fiveHour: UsageWindow;
  /** Rolling 7-day (weekly) window — the account-wide cap. */
  sevenDay: UsageWindow;
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
  return (
    isWindow(r.fiveHour) &&
    isWindow(r.sevenDay) &&
    typeof r.updatedAt === "string"
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

/** Read the usage snapshot the user's hook writes. Never fetches anything. */
export async function readUsage(): Promise<UsageData | null> {
  try {
    const raw = await fs.readFile(USAGE_FILE, "utf-8");
    return parseUsage(raw);
  } catch {
    return null; // absent / unreadable — the chip simply doesn't show
  }
}

/** Read one or more usage snapshots the user's hook writes. Never fetches. */
export async function readUsageAccounts(): Promise<UsageAccount[]> {
  try {
    const raw = await fs.readFile(USAGE_FILE, "utf-8");
    return parseUsageAccounts(raw);
  } catch {
    return [];
  }
}
