import { createPollingTask } from "../polling-task";
import { useEffect, useState } from "react";
import {
  pollVisible,
  SESSION_MONITOR_POLL_INTERVAL_MS,
  USAGE_POLL_INTERVAL_MS,
} from "../poll-visible";
import type { GrokUsage, MonitoredSession, UsageAccount } from "../types";

export function useUsagePolling(
  samePollPayload: <T>(prev: T, next: T) => boolean,
) {
  const [usageAccounts, setUsageAccounts] = useState<UsageAccount[]>([]);
  const [codexUsageAccounts, setCodexUsageAccounts] = useState<
    UsageAccount[]
  >([]);
  const [antigravityUsageAccounts, setAntigravityUsageAccounts] = useState<UsageAccount[]>([]);
  const [grokUsage, setGrokUsage] = useState<GrokUsage | null>(null);
  const [monitoredSessions, setMonitoredSessions] = useState<MonitoredSession[]>([]);

  // Poll provider usage: local snapshots and the official Antigravity CLI command.
  // Authentication stays with the provider tools.
  useEffect(() => {
    const tasks = [
      createPollingTask(() => window.aya.getUsage(), value => setUsageAccounts(prev => samePollPayload(prev, value) ? prev : value)),
      createPollingTask(() => window.aya.getCodexUsage(), value => setCodexUsageAccounts(prev => samePollPayload(prev, value) ? prev : value)),
      createPollingTask(() => window.aya.getAntigravityUsage(), value => setAntigravityUsageAccounts(prev => samePollPayload(prev, value) ? prev : value)),
      createPollingTask(() => window.aya.getGrokUsage(), value => setGrokUsage(prev => samePollPayload(prev, value) ? prev : value)),
    ];
    const stop = pollVisible(() => tasks.forEach(task => task.refresh()), USAGE_POLL_INTERVAL_MS);
    return () => { stop(); tasks.forEach(task => task.stop()); };
  }, [samePollPayload]);

  useEffect(() => {
    const task = createPollingTask(() => window.aya.listMonitoredSessions(), sessions => {
      setMonitoredSessions(prev => samePollPayload(prev, sessions) ? prev : sessions);
    });
    const stop = pollVisible(task.refresh, SESSION_MONITOR_POLL_INTERVAL_MS);
    return () => { stop(); task.stop(); };
  }, [samePollPayload]);

  return { usageAccounts, codexUsageAccounts, antigravityUsageAccounts, grokUsage, monitoredSessions };
}

export function useHarnessScan() {
  const [harnessScanDone, setHarnessScanDone] = useState(false);
  const [foundHarnessCount, setFoundHarnessCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.aya.scanHarnesses().then((found) => {
      if (cancelled) return;
      setFoundHarnessCount(found.length);
      setHarnessScanDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { foundHarnessCount, harnessScanDone };
}
