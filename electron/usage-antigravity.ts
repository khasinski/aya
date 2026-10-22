// Ask the official CLI to run its built-in /usage command. No model call,
// token access, local-server discovery, or direct Google requests in Aya.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { UsageAccount, UsageData } from "./usage";
import { singleFlight } from "./single-flight";

export function parseAntigravityUsage(raw: string, nowMs = Date.now()): UsageAccount[] {
  let data;
  try { data = JSON.parse(raw); } catch { return []; }
  if (data?.status !== "SUCCESS" || data.command?.name !== "usage" || !Array.isArray(data.command.data?.groups)) return [];
  const result: UsageAccount[] = [];
  for (const [index, group] of data.command.data.groups.entries()) {
    if (typeof group?.name !== "string" || !group.name.trim() || !Array.isArray(group.buckets)) continue;
    const usage: UsageData = { updatedAt: new Date(nowMs).toISOString() };
    for (const bucket of group.buckets) {
      const fraction = bucket?.remaining_fraction;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      const reset = bucket.reset_time;
      if (typeof reset !== "string" || !Number.isFinite(Date.parse(reset)) || Date.parse(reset) <= nowMs) continue;
      const win = { pct: (1 - fraction) * 100, resetsAt: reset };
      if (bucket.window === "weekly") usage.sevenDay = win;
      if (bucket.window === "5h") usage.fiveHour = win;
    }
    if (usage.sevenDay || usage.fiveHour) result.push({ id: `antigravity-${index}`, label: group.name, usage });
  }
  return result;
}

/** Cache across windows, coalesce overlapping polls and back off on failures.
 * Retain the last snapshot on transient errors; the UI marks it stale. */
export function createAntigravityUsageReader(
  run: () => Promise<string> = runUsageCommand,
  clock: () => number = Date.now,
): () => Promise<UsageAccount[]> {
  let snapshot: UsageAccount[] = [];
  let nextPoll = 0;
  return singleFlight(async () => {
    const now = clock();
    if (now < nextPoll) return snapshot;
    nextPoll = now + 60_000;
    try {
      const parsed = parseAntigravityUsage(await run(), clock());
      if (parsed.length) snapshot = parsed;
    } catch { /* Missing CLI, logged out, timeout or offline: no invented zero. */ }
    return snapshot;
  });
}

function runUsageCommand(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("agy", ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"], {
      cwd: tmpdir(), timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8",
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export const readAntigravityUsage = createAntigravityUsageReader();
