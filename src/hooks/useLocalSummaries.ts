import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  LOCAL_SUMMARY_BUFFER_LINES,
  LOCAL_SUMMARY_DEBOUNCE_MS,
  LOCAL_SUMMARY_MIN_LINES,
  LOCAL_SUMMARY_MIN_NEW_LINES,
  LOCAL_SUMMARY_MIN_UPDATE_MS,
  LOCAL_SUMMARY_REFRESH_MS,
  cleanTerminalOutput,
  readAyaIntelligenceConfig,
  readSummaryCache,
  summariesFromCache,
  summaryHash,
  type AutoSummaryStatus,
} from "../local-summaries";
import { localSummaryUnavailableMessage } from "../local-summary-errors";
import { LOCAL_SUMMARY_MAX_LINES } from "../main-mirrors";
import {
  AYA_INTELLIGENCE_STORAGE_KEY,
  LOCAL_SUMMARIES_STORAGE_KEY,
  LOCAL_SUMMARY_CACHE_STORAGE_KEY,
} from "../storage-keys";
import type { AyaIntelligenceConfig, ProjectConfig, TerminalState } from "../types";
import { boolPreference, usePersistentPreference } from "./usePersistentPreference";

const LOCAL_SUMMARIES_CODEC = boolPreference(false);

interface LocalSummariesOptions {
  terminalsRef: RefObject<Record<string, TerminalState>>;
  projectsRef: RefObject<ProjectConfig[]>;
}

export function useLocalSummaries({ terminalsRef, projectsRef }: LocalSummariesOptions) {
  const [localSummariesEnabled, setLocalSummariesEnabled] =
    usePersistentPreference(LOCAL_SUMMARIES_STORAGE_KEY, LOCAL_SUMMARIES_CODEC);
  const [ayaIntelligence, setAyaIntelligence] = useState<AyaIntelligenceConfig>(
    readAyaIntelligenceConfig,
  );
  const [initialSummaryCache] = useState(readSummaryCache);
  const [terminalSummaries, setTerminalSummaries] = useState<Record<string, string>>(
    () => summariesFromCache(initialSummaryCache, "terminal"),
  );
  const [projectSummaries, setProjectSummaries] = useState<Record<string, string>>(
    () => summariesFromCache(initialSummaryCache, "project"),
  );
  const [summaryNudge, setSummaryNudge] = useState(0);
  const [autoSummaryStatus, setAutoSummaryStatus] = useState<AutoSummaryStatus>({
    terminalCount: 0,
    terminalsWithLines: 0,
    totalLines: 0,
    lastEvent: "No automatic summary run yet.",
  });
  const terminalOutputRef = useRef<Record<string, string[]>>({});
  const localSummariesEnabledRef = useRef(localSummariesEnabled);
  localSummariesEnabledRef.current = localSummariesEnabled;
  const ayaIntelligenceRef = useRef(ayaIntelligence);
  ayaIntelligenceRef.current = ayaIntelligence;
  const summaryMetaRef = useRef<
    Record<
      string,
      { hash: string; updatedAt: number; inFlight: boolean; lineCount: number }
    >
  >({});
  const summaryTimersRef = useRef<Record<string, number>>({});

  const runAutomaticSummary = useCallback(
    async (
      key: string,
      kind: "terminal" | "project",
      lines: string[],
      apply: (summary: string) => void,
    ) => {
      const intelligence = ayaIntelligenceRef.current;
      if (
        !localSummariesEnabledRef.current ||
        (intelligence.provider === "apple" && window.aya.platform !== "darwin")
      ) {
        return;
      }
      const recent = lines.slice(-LOCAL_SUMMARY_MAX_LINES);
      if (recent.length < LOCAL_SUMMARY_MIN_LINES) {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: not enough output (${recent.length} line${recent.length === 1 ? "" : "s"}).`,
        }));
        return;
      }
      const hash = summaryHash(recent);
      const meta = summaryMetaRef.current[key];
      if (meta?.inFlight || meta?.hash === hash) return;
      if (
        meta &&
        Date.now() - meta.updatedAt < LOCAL_SUMMARY_MIN_UPDATE_MS &&
        recent.length - meta.lineCount < LOCAL_SUMMARY_MIN_NEW_LINES
      ) {
        return;
      }
      summaryMetaRef.current[key] = {
        hash,
        updatedAt: Date.now(),
        inFlight: true,
        lineCount: recent.length,
      };
      try {
        const result = await window.aya.summarizeLocal({
          kind,
          lines: recent,
          intelligence,
        });
        if (!result.available) {
          const message = localSummaryUnavailableMessage(
            result.error,
            intelligence.provider,
          );
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: ${message}`,
          }));
          return;
        }
        if (!result.useful) {
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: provider returned no useful summary.`,
          }));
          return;
        }
        apply(result.summary);
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: ${result.summary}`,
        }));
      } catch {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: request failed.`,
        }));
      } finally {
        const current = summaryMetaRef.current[key];
        if (current?.hash === hash) {
          summaryMetaRef.current[key] = {
            ...current,
            updatedAt: Date.now(),
            inFlight: false,
            lineCount: recent.length,
          };
        }
      }
    },
    [],
  );

  const scheduleTerminalSummary = useCallback(
    (terminalId: string) => {
      window.clearTimeout(summaryTimersRef.current[terminalId]);
      summaryTimersRef.current[terminalId] = window.setTimeout(() => {
        const terminal = terminalsRef.current[terminalId];
        if (!terminal) return;
        const terminalLines = terminalOutputRef.current[terminalId] ?? [];
        const outputEntries = Object.values(terminalOutputRef.current);
        setAutoSummaryStatus((prev) => ({
          ...prev,
          terminalCount: Object.keys(terminalsRef.current).length,
          terminalsWithLines: outputEntries.filter((lines) => lines.length > 0)
            .length,
          totalLines: outputEntries.reduce((sum, lines) => sum + lines.length, 0),
        }));
        void runAutomaticSummary(
          `terminal:${terminalId}`,
          "terminal",
          terminalLines,
          (summary) =>
            setTerminalSummaries((prev) => ({
              ...prev,
              [terminalId]: summary,
            })),
        );
        const projectLines = Object.values(terminalsRef.current)
          .filter((item) => item.projectSlug === terminal.projectSlug)
          .flatMap((item) => terminalOutputRef.current[item.id] ?? []);
        void runAutomaticSummary(
          `project:${terminal.projectSlug}`,
          "project",
          projectLines,
          (summary) =>
            setProjectSummaries((prev) => ({
              ...prev,
              [terminal.projectSlug]: summary,
            })),
        );
      }, LOCAL_SUMMARY_DEBOUNCE_MS);
    },
    [runAutomaticSummary, terminalsRef],
  );

  const rememberTerminalOutput = useCallback((terminalId: string, chunk: string) => {
    // Summaries are opt-in; when off, skip the regex cleaning, buffering, and
    // scheduling entirely so PTY output isn't taxed on its hot path.
    if (!localSummariesEnabledRef.current) return;
    const lines = cleanTerminalOutput(chunk);
    if (lines.length === 0) return;
    const current = terminalOutputRef.current[terminalId] ?? [];
    terminalOutputRef.current[terminalId] = [...current, ...lines].slice(
      -LOCAL_SUMMARY_BUFFER_LINES,
    );
    // scheduleTerminalSummary already debounces the actual summary work off
    // refs (no per-chunk render). The account-wide "refresh all" effect is
    // driven by mount / its interval / settings changes / the manual button —
    // bumping state on every chunk just re-rendered the whole app for nothing.
    scheduleTerminalSummary(terminalId);
  }, [scheduleTerminalSummary]);

  const updateAyaIntelligence = useCallback((next: AyaIntelligenceConfig) => {
    setAyaIntelligence(next);
    summaryMetaRef.current = {};
    setSummaryNudge((n) => n + 1);
    try {
      localStorage.setItem(AYA_INTELLIGENCE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore — localStorage can be unavailable in odd embedded contexts */
    }
  }, []);

  return {
    localSummariesEnabled,
    setLocalSummariesEnabled,
    ayaIntelligence,
    terminalSummaries,
    projectSummaries,
    setSummaryNudge,
    autoSummaryStatus,
    rememberTerminalOutput,
    updateAyaIntelligence,
    effects: {
      terminalsRef,
      projectsRef,
      terminalOutputRef,
      summaryMetaRef,
      terminalSummaries,
      setTerminalSummaries,
      projectSummaries,
      setProjectSummaries,
      localSummariesEnabled,
      ayaIntelligence,
      summaryNudge,
      setAutoSummaryStatus,
    },
  };
}

type LocalSummaryEffects = ReturnType<typeof useLocalSummaries>["effects"];

// Called at the original effect position so bootstrap and PTY subscriptions
// retain their order relative to summary cleanup, cache writes, and refreshes.
export function useLocalSummaryEffects(
  terminals: Record<string, TerminalState>,
  {
    terminalsRef,
    projectsRef,
    terminalOutputRef,
    summaryMetaRef,
    terminalSummaries,
    setTerminalSummaries,
    projectSummaries,
    setProjectSummaries,
    localSummariesEnabled,
    ayaIntelligence,
    summaryNudge,
    setAutoSummaryStatus,
  }: LocalSummaryEffects,
) {
  useEffect(() => {
    const liveIds = new Set(Object.keys(terminals));
    for (const id of Object.keys(terminalOutputRef.current)) {
      if (!liveIds.has(id)) delete terminalOutputRef.current[id];
    }
    setTerminalSummaries((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const id of Object.keys(next)) {
        if (!liveIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [terminals, terminalOutputRef, setTerminalSummaries]);

  useEffect(() => {
    try {
      const now = Date.now();
      const terminal = Object.fromEntries(
        Object.entries(terminalSummaries)
          .filter(([, summary]) => summary.trim())
          .map(([id, summary]) => [id, { summary: summary.trim(), updatedAt: now }]),
      );
      const project = Object.fromEntries(
        Object.entries(projectSummaries)
          .filter(([, summary]) => summary.trim())
          .map(([slug, summary]) => [
            slug,
            { summary: summary.trim(), updatedAt: now },
          ]),
      );
      localStorage.setItem(
        LOCAL_SUMMARY_CACHE_STORAGE_KEY,
        JSON.stringify({ terminal, project }),
      );
    } catch {
      /* ignore — summaries are a cache only */
    }
  }, [terminalSummaries, projectSummaries]);

  useEffect(() => {
    if (
      !localSummariesEnabled ||
      (ayaIntelligence.provider === "apple" && window.aya.platform !== "darwin")
    ) {
      return;
    }

    let cancelled = false;
    const runOne = async (
      key: string,
      kind: "terminal" | "project",
      lines: string[],
      apply: (summary: string) => void,
    ) => {
      const recent = lines.slice(-LOCAL_SUMMARY_MAX_LINES);
      if (recent.length < LOCAL_SUMMARY_MIN_LINES) {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: not enough output (${recent.length} line${recent.length === 1 ? "" : "s"}).`,
        }));
        return;
      }
      const hash = summaryHash(recent);
      const meta = summaryMetaRef.current[key];
      if (meta?.inFlight || meta?.hash === hash) return;
      if (
        meta &&
        Date.now() - meta.updatedAt < LOCAL_SUMMARY_MIN_UPDATE_MS &&
        recent.length - meta.lineCount < LOCAL_SUMMARY_MIN_NEW_LINES
      ) {
        return;
      }
      summaryMetaRef.current[key] = {
        hash,
        updatedAt: Date.now(),
        inFlight: true,
        lineCount: recent.length,
      };
      try {
        const result = await window.aya.summarizeLocal({
          kind,
          lines: recent,
          intelligence: ayaIntelligence,
        });
        if (cancelled) {
          delete summaryMetaRef.current[key];
          return;
        }
        if (!result.available) {
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: provider unavailable${result.error ? ` (${result.error})` : ""}.`,
          }));
          return;
        }
        if (!result.useful) {
          setAutoSummaryStatus((prev) => ({
            ...prev,
            lastEvent: `${kind}: provider returned no useful summary.`,
          }));
          return;
        }
        apply(result.summary);
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: ${result.summary}`,
        }));
      } catch {
        setAutoSummaryStatus((prev) => ({
          ...prev,
          lastEvent: `${kind}: request failed.`,
        }));
      } finally {
        const current = summaryMetaRef.current[key];
        if (current?.hash === hash) {
          summaryMetaRef.current[key] = {
            ...current,
            updatedAt: Date.now(),
            inFlight: false,
            lineCount: recent.length,
          };
        }
      }
    };

    const linesForTerminal = async (terminalId: string): Promise<string[]> => {
      const existing = terminalOutputRef.current[terminalId] ?? [];
      if (existing.length >= LOCAL_SUMMARY_MIN_LINES) return existing;
      try {
        const buffered = await window.aya.ptyBuffer(terminalId);
        const lines = cleanTerminalOutput(buffered);
        if (lines.length > existing.length) {
          terminalOutputRef.current[terminalId] = lines.slice(
            -LOCAL_SUMMARY_BUFFER_LINES,
          );
          return terminalOutputRef.current[terminalId];
        }
      } catch {
        // best effort; live event collection still covers new output
      }
      return existing;
    };

    const refresh = () => {
      const terminalList = Object.values(terminalsRef.current);
      const outputEntries = Object.values(terminalOutputRef.current);
      setAutoSummaryStatus((prev) => ({
        ...prev,
        terminalCount: terminalList.length,
        terminalsWithLines: outputEntries.filter((lines) => lines.length > 0).length,
        totalLines: outputEntries.reduce((sum, lines) => sum + lines.length, 0),
      }));
      for (const terminal of terminalList) {
        void linesForTerminal(terminal.id).then((lines) =>
          runOne(`terminal:${terminal.id}`, "terminal", lines, (summary) =>
            setTerminalSummaries((prev) => ({
              ...prev,
              [terminal.id]: summary,
            })),
          ),
        );
      }

      for (const project of projectsRef.current) {
        const projectTerminals = terminalList.filter(
          (terminal) => terminal.projectSlug === project.slug,
        );
        void Promise.all(
          projectTerminals.map((terminal) => linesForTerminal(terminal.id)),
        ).then((lineGroups) => {
          const lines = lineGroups.flat().slice(-LOCAL_SUMMARY_MAX_LINES);
          return runOne(`project:${project.slug}`, "project", lines, (summary) =>
            setProjectSummaries((prev) => ({
              ...prev,
              [project.slug]: summary,
            })),
          );
        });
      }
    };

    const timeout = window.setTimeout(
      refresh,
      summaryNudge === 0 ? 0 : LOCAL_SUMMARY_DEBOUNCE_MS,
    );
    const id = window.setInterval(refresh, LOCAL_SUMMARY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearInterval(id);
    };
  }, [ayaIntelligence, localSummariesEnabled, summaryNudge, terminalsRef, projectsRef, terminalOutputRef, summaryMetaRef, setTerminalSummaries, setProjectSummaries, setAutoSummaryStatus]);

}
