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
    let cancelled = false;
    const refresh = () => {
      void window.aya.getUsage().then((u) => {
        if (!cancelled) {
          setUsageAccounts((prev) => (samePollPayload(prev, u) ? prev : u));
        }
      });
      void window.aya.getCodexUsage().then((u) => {
        if (!cancelled) {
          setCodexUsageAccounts((prev) =>
            samePollPayload(prev, u) ? prev : u,
          );
        }
      });
      void window.aya.getAntigravityUsage().then((u) => {
        if (!cancelled) setAntigravityUsageAccounts((prev) => samePollPayload(prev, u) ? prev : u);
      }).catch(() => {});
      void window.aya.getGrokUsage().then((u) => {
        if (!cancelled) {
          setGrokUsage((prev) => (samePollPayload(prev, u) ? prev : u));
        }
      });
    };
    const stop = pollVisible(refresh, USAGE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [samePollPayload]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void window.aya.listMonitoredSessions().then((sessions) => {
        if (!cancelled) {
          setMonitoredSessions((prev) =>
            samePollPayload(prev, sessions) ? prev : sessions,
          );
        }
      });
    };
    const stop = pollVisible(refresh, SESSION_MONITOR_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
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
