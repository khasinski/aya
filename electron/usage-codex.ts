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
import type { UsageData } from "./usage";

const CODEX_HOME =
  process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");

// Bound the per-poll work: only the few most-recent rollouts are read/parsed.
const MAX_ROLLOUTS_SCANNED = 20;

function isoFromUnixSeconds(sec: unknown): string | undefined {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return undefined;
  return new Date(sec * 1000).toISOString();
}

/** Map Codex's rate_limits object to Aya's shared UsageData. `primary` is the
 *  5-hour window, `secondary` the weekly one; both carry `used_percent`.
 *  `resets_at` is Unix SECONDS (Codex's wire format). `updatedAtMs` is when the
 *  snapshot was produced. Returns null if either percentage is missing. */
export function codexUsageFromRateLimit(
  rl: unknown,
  updatedAtMs: number,
): UsageData | null {
  if (typeof rl !== "object" || rl === null) return null;
  const r = rl as {
    primary?: { used_percent?: unknown; resets_at?: unknown };
    secondary?: { used_percent?: unknown; resets_at?: unknown };
  };
  const p = r.primary?.used_percent;
  const s = r.secondary?.used_percent;
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  if (typeof s !== "number" || !Number.isFinite(s)) return null;
  return {
    fiveHour: { pct: p, resetsAt: isoFromUnixSeconds(r.primary?.resets_at) },
    sevenDay: { pct: s, resetsAt: isoFromUnixSeconds(r.secondary?.resets_at) },
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
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

/** The most-recently-modified rollout files under ~/.codex/sessions, newest
 *  first, capped — so an old session that just hasn't emitted a snapshot yet
 *  doesn't sink the chip, without reading the whole history every poll. */
async function recentRolloutFiles(): Promise<{ file: string; mtimeMs: number }[]> {
  const root = path.join(CODEX_HOME, "sessions");
  const found: { file: string; mtimeMs: number }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          const st = await fs.stat(full);
          found.push({ file: full, mtimeMs: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, MAX_ROLLOUTS_SCANNED);
}

/** Read Codex's account-wide usage from its newest rollout that carries a
 *  snapshot. Returns null if Codex isn't present or none of the recent rollouts
 *  has a rate-limit event yet. */
export async function readCodexUsage(): Promise<UsageData | null> {
  for (const f of await recentRolloutFiles()) {
    let raw: string;
    try {
      raw = await fs.readFile(f.file, "utf-8");
    } catch {
      continue;
    }
    const usage = latestUsageFromLines(raw.split("\n"), f.mtimeMs);
    if (usage) return usage;
  }
  return null;
}
