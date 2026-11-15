import {
  useEffect,
  useRef,
  useState
} from "react";
import { formatHarnessSearchCoverage } from "../harness-search-coverage";
import { beginHistorySearch } from "../harness-search-sequence";
import type {
  HarnessSearchHit,
  HarnessSearchResult
} from "../types";
import { FindBarCoverageLine } from "./FindBarCoverageLine";
import { formatLastActivity } from './TerminalPresentation';
import { ipcMessage } from "./use-async-action";


export interface FindBarProps {
  value: string;
  /** `historyMode` tells the host whether the query is driving the live
   *  terminal search (false) or the transcript search inside the bar (true). */
  onChange: (v: string, historyMode: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Non-null enables the experimental History mode for this agent tab. */
  historyAgent: "claude" | "codex" | null;
  paneId: string;
  cwd: string;
  configDir?: string;
  /** The preset's command: an inline CODEX_HOME there moves the history too. */
  command?: string;
  /** Clears xterm search highlights when the bar switches to History mode. */
  onClearTerminalMatches: () => void;
  /** A completed result can be supplied when restoring/rendering the bar. */
  initialHistoryResult?: HarnessSearchResult;
  /** A refusal can be supplied when restoring/rendering the bar. */
  initialHistoryError?: string;
  /** True when live terminal search found zero matches for the current query. */
  noMatch?: boolean;
}


// History (transcript) search: debounce keystrokes before the IPC round-trip
// and skip 1-character queries, which match everything.
export const HISTORY_SEARCH_DEBOUNCE_MS = 200;

export const HISTORY_MIN_QUERY_CHARS = 2;


export function formatHitTime(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) return null;
  return formatLastActivity(ms) ?? "just now";
}


export function FindBar({
  value,
  onChange,
  onNext,
  onPrev,
  onClose,
  historyAgent,
  paneId,
  cwd,
  configDir,
  command,
  onClearTerminalMatches,
  initialHistoryResult,
  initialHistoryError,
  noMatch = false,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [historyMode, setHistoryMode] = useState(initialHistoryResult !== undefined);
  const [hits, setHits] = useState<HarnessSearchHit[]>(initialHistoryResult?.hits ?? []);
  const [coverage, setCoverage] = useState<HarnessSearchResult["coverage"]>(initialHistoryResult?.coverage ?? { partial: false });
  // True once a transcript search has completed for the current query, so
  // "No matches" only shows after an actual (empty) result, not while typing.
  const [searched, setSearched] = useState(initialHistoryResult !== undefined);
  const [historyError, setHistoryError] = useState<string | null>(initialHistoryError ?? null);
  const [expandedHit, setExpandedHit] = useState<number | null>(null);
  const historySeqRef = useRef(0);
  const historyRequestIdRef = useRef(0);
  useEffect(() => {
    // Focus + select-all on mount so opening the bar twice in a row lets
    // the user replace the query directly.
    inputRef.current?.focus();
    inputRef.current?.select();
    if (typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const historyActive = historyMode && historyAgent !== null;
  const query = value.trim();
  useEffect(() => {
    const { id: seq, shouldSearch } = beginHistorySearch(
      historySeqRef,
      query,
      HISTORY_MIN_QUERY_CHARS,
    );
    if (!historyActive || !historyAgent) return;
    if (!shouldSearch) {
      setHits([]);
      setCoverage({ partial: false });
      setSearched(false);
      setHistoryError(null);
      setExpandedHit(null);
      return;
    }
    // Results belong to the previous query and must not remain visible under
    // this one while its debounced request is waiting or being cancelled.
    setHits([]);
    setCoverage({ partial: false });
    setSearched(false);
    setHistoryError(null);
    setExpandedHit(null);
    let requestId: string | undefined;
    const timer = window.setTimeout(() => {
      requestId = `history-${seq}-${++historyRequestIdRef.current}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.aya
        .harnessSearch({ agent: historyAgent, cwd, configDir, command, query }, requestId, paneId)
        .then((results) => {
          if (historySeqRef.current !== seq) return; // stale response
          if (results.coverage.cancelled) {
            setHits([]);
            setCoverage({ partial: false });
            setSearched(false);
            setHistoryError(null);
            setExpandedHit(null);
            return;
          }
          setHits(results.hits);
          setCoverage(results.coverage);
          setSearched(true);
          setHistoryError(null);
          setExpandedHit(null);
        })
        .catch((error: unknown) => {
          if (historySeqRef.current !== seq) return;
          setHits([]);
          setCoverage({ partial: false });
          setSearched(true);
          setHistoryError(ipcMessage(error));
        });
    }, HISTORY_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (requestId) void window.aya.harnessSearchCancel(requestId, paneId).catch(() => {});
    };
  }, [historyActive, historyAgent, cwd, configDir, command, query, paneId]);

  const switchMode = (toHistory: boolean) => {
    if (toHistory === historyMode) return;
    setHistoryMode(toHistory);
    setExpandedHit(null);
    if (toHistory) {
      onClearTerminalMatches();
    } else {
      setHits([]);
      setCoverage({ partial: false });
      setSearched(false);
      setHistoryError(null);
      // Re-run the live terminal search for the query already in the box.
      onChange(value, false);
    }
    inputRef.current?.focus();
  };

  const agentLabel = historyAgent === "claude" ? "Claude" : "Codex";
  const partialCoverageText = formatHarnessSearchCoverage(
    coverage,
    hits.length > 0,
    agentLabel,
  );
  return (
    <div className={`aya-findbar ${historyActive ? "aya-findbar--history" : ""}`}>
      <div className="aya-findbar-row">
        {historyAgent && (
          <div
            className="aya-findbar-modes"
            aria-label="Search scope"
            title="Terminal searches visible output; History searches this directory's agent session transcripts"
          >
            {([
              [false, "Terminal"],
              [true, "History"],
            ] as const).map(([mode, label]) => (
              <button
                key={label}
                type="button"
                className={`aya-findbar-mode ${
                  historyMode === mode ? "aya-findbar-mode--active" : ""
                }`}
                onClick={() => switchMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <input
          ref={inputRef}
          className="aya-findbar-input"
          value={value}
          onChange={(e) => onChange(e.target.value, historyActive)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter" && !historyActive) {
              e.preventDefault();
              if (e.shiftKey) onPrev();
              else onNext();
            }
          }}
          placeholder={
            historyActive
              ? `Search ${agentLabel} session history…`
              : "Find in terminal…"
          }
          spellCheck={false}
        />
        {!historyActive && query.length > 0 && noMatch && (
          <span className="aya-findbar-count" data-testid="findbar-no-matches">
            No matches
          </span>
        )}
        {!historyActive && (
          <>
            <button
              className="aya-findbar-btn"
              onClick={onPrev}
              title="Previous match (Shift+Enter)"
            >
              ↑
            </button>
            <button
              className="aya-findbar-btn"
              onClick={onNext}
              title="Next match (Enter)"
            >
              ↓
            </button>
          </>
        )}
        <button
          className="aya-findbar-btn"
          onClick={onClose}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      {historyActive && (searched || hits.length > 0 || historyError !== null) && (
        <div className="aya-findbar-results">
          {hits.length === 0 ? (
            <div className="aya-findbar-empty">
              {historyError ?? (partialCoverageText
                ? <FindBarCoverageLine coverage={coverage} hasHits={false} agentLabel={agentLabel} />
                : `No matches in recent ${agentLabel} sessions for this directory`)}
            </div>
          ) : (
            hits.map((hit, index) => {
              const time = formatHitTime(hit.timestamp);
              const expanded = expandedHit === index;
              return (
                <button
                  key={`${hit.sessionId}-${index}`}
                  type="button"
                  className="aya-findbar-hit"
                  onClick={() => setExpandedHit(expanded ? null : index)}
                  title={expanded ? "Collapse" : "Expand full message"}
                >
                  <div className="aya-findbar-hit-meta">
                    <span className="aya-findbar-hit-role">
                      {hit.role === "user" ? "You" : agentLabel}
                    </span>
                    {time && <span>{time}</span>}
                  </div>
                  {expanded ? (
                    <div
                      className="aya-findbar-hit-full"
                      // Let the user select/copy the text without the click
                      // bubbling to the row button and collapsing it.
                      onClick={(e) => e.stopPropagation()}
                    >
                      {hit.text}
                    </div>
                  ) : (
                    <div className="aya-findbar-hit-snippet">
                      {hit.snippet.slice(0, hit.matchStart)}
                      <mark>
                        {hit.snippet.slice(
                          hit.matchStart,
                          hit.matchStart + hit.matchLength,
                        )}
                      </mark>
                      {hit.snippet.slice(hit.matchStart + hit.matchLength)}
                    </div>
                  )}
                </button>
              );
            })
          )}
          {partialCoverageText && hits.length > 0 && (
            <FindBarCoverageLine coverage={coverage} hasHits agentLabel={agentLabel} />
          )}
        </div>
      )}
    </div>
  );
}
