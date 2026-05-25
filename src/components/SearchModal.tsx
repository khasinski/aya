import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BufferSearchHit,
  getPreset,
  type Preset,
  type ProjectConfig,
  type TerminalState,
} from "../types";

interface Props {
  projects: ProjectConfig[];
  terminals: Record<string, TerminalState>;
  presets: Preset[];
  /** Map of terminalId → ms timestamp of last PTY data, for ranking the
   *  default (empty-query) list by recency. */
  lastActivity: Record<string, number>;
  onSelectProject: (slug: string) => void;
  onSelectTerminal: (slug: string, terminalId: string) => void;
  onClose: () => void;
}

export interface SearchResult {
  kind: "project" | "terminal";
  projectSlug: string;
  terminalId?: string;
  label: string;
  secondary: string;
  icon: string;
  iconColor?: string;
  /** Higher = more relevant. Used to sort. */
  score: number;
  /** When matched by buffer content, the snippet to show under the label
   *  with the match offset highlighted. */
  snippet?: string;
  matchStart?: number;
  matchLength?: number;
  moreOccurrences?: number;
}

function projectScore(name: string, query: string): number {
  const n = name.toLowerCase();
  if (n === query) return 1000;
  if (n.startsWith(query)) return 500;
  if (n.includes(query)) return 200;
  return 0;
}
function terminalScore(name: string, query: string): number {
  const n = name.toLowerCase();
  if (n === query) return 500;
  if (n.startsWith(query)) return 250;
  if (n.includes(query)) return 100;
  return 0;
}

function buildResults(
  query: string,
  projects: ProjectConfig[],
  terminals: Record<string, TerminalState>,
  presets: Preset[],
  lastActivity: Record<string, number>,
  contentHits: BufferSearchHit[],
): SearchResult[] {
  const q = query.trim().toLowerCase();
  const out: SearchResult[] = [];

  if (!q) {
    // Default: all terminals sorted by recent activity, then projects.
    const ts = Object.values(terminals).slice().sort((a, b) => {
      const la = lastActivity[a.id] ?? 0;
      const lb = lastActivity[b.id] ?? 0;
      return lb - la;
    });
    for (const t of ts) {
      const project = projects.find((p) => p.slug === t.projectSlug);
      const preset = getPreset(presets, t.presetId);
      out.push({
        kind: "terminal",
        projectSlug: t.projectSlug,
        terminalId: t.id,
        label: t.name,
        secondary: project ? `in ${project.name}` : "",
        icon: preset.icon,
        iconColor: preset.color || undefined,
        score: 0,
      });
    }
    for (const p of projects) {
      out.push({
        kind: "project",
        projectSlug: p.slug,
        label: p.name,
        secondary: p.directory,
        icon: "📁",
        score: -1,
      });
    }
    return out;
  }

  // Project name matches.
  for (const p of projects) {
    const s = projectScore(p.name, q);
    if (s > 0) {
      out.push({
        kind: "project",
        projectSlug: p.slug,
        label: p.name,
        secondary: p.directory,
        icon: "📁",
        score: s,
      });
    }
  }

  // Terminal name matches.
  const tnMatched = new Set<string>();
  for (const t of Object.values(terminals)) {
    const s = terminalScore(t.name, q);
    if (s > 0) {
      const project = projects.find((p) => p.slug === t.projectSlug);
      const preset = getPreset(presets, t.presetId);
      tnMatched.add(t.id);
      out.push({
        kind: "terminal",
        projectSlug: t.projectSlug,
        terminalId: t.id,
        label: t.name,
        secondary: project ? `in ${project.name}` : "",
        icon: preset.icon,
        iconColor: preset.color || undefined,
        score: s,
      });
    }
  }

  // Content matches — skip terminals already surfaced by name to avoid
  // duplicate rows.
  for (const hit of contentHits) {
    if (tnMatched.has(hit.ptyId)) continue;
    const t = terminals[hit.ptyId];
    if (!t) continue;
    const project = projects.find((p) => p.slug === t.projectSlug);
    const preset = getPreset(presets, t.presetId);
    out.push({
      kind: "terminal",
      projectSlug: t.projectSlug,
      terminalId: t.id,
      label: t.name,
      secondary: project ? `in ${project.name}` : "",
      icon: preset.icon,
      iconColor: preset.color || undefined,
      score: 10 + Math.min(hit.more, 50),
      snippet: hit.snippet,
      matchStart: hit.matchStart,
      matchLength: hit.matchLength,
      moreOccurrences: hit.more,
    });
  }

  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, 50);
}

export function SearchModal({
  projects,
  terminals,
  presets,
  lastActivity,
  onSelectProject,
  onSelectTerminal,
  onClose,
}: Props) {
  // Input value drives the field; query is the debounced version used for
  // ranking + content RPC. Both updating off the same keystroke would
  // re-render the result list per character, which feels like flicker.
  const [inputValue, setInputValue] = useState("");
  const [query, setQuery] = useState("");
  const [contentHits, setContentHits] = useState<BufferSearchHit[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounce inputValue → query. 100ms strikes a balance: fast enough that
  // it feels live, slow enough that single keystrokes don't trigger a
  // full re-rank + RPC round-trip.
  useEffect(() => {
    const id = setTimeout(() => setQuery(inputValue), 100);
    return () => clearTimeout(id);
  }, [inputValue]);

  // Content-search RPC piggybacks on the same debounced query.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setContentHits([]);
      return;
    }
    let cancelled = false;
    void window.aya.ptySearch(q).then((hits) => {
      if (!cancelled) setContentHits(hits);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const results = useMemo(
    () =>
      buildResults(
        query,
        projects,
        terminals,
        presets,
        lastActivity,
        contentHits,
      ),
    [query, projects, terminals, presets, lastActivity, contentHits],
  );

  // Clamp the selection when the result list shrinks.
  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndex]);

  // Scroll the focused row into view as you arrow through the list.
  useEffect(() => {
    const el = listRef.current?.querySelector(
      `[data-idx="${selectedIndex}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const select = (r: SearchResult) => {
    if (r.kind === "terminal" && r.terminalId) {
      onSelectTerminal(r.projectSlug, r.terminalId);
    } else {
      onSelectProject(r.projectSlug);
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[selectedIndex];
      if (chosen) select(chosen);
    }
  };

  return (
    <div className="aya-modal-backdrop" onClick={onClose}>
      <div
        className="aya-modal aya-modal--search"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="aya-search-input"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search projects, terminals, output…"
          spellCheck={false}
        />
        <div className="aya-search-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="aya-search-empty">No matches.</div>
          ) : (
            results.map((r, i) => (
              <ResultRow
                key={`${r.kind}-${r.projectSlug}-${r.terminalId ?? "_"}-${i}`}
                result={r}
                selected={i === selectedIndex}
                index={i}
                onClick={() => select(r)}
                onMouseEnter={() => setSelectedIndex(i)}
              />
            ))
          )}
        </div>
        <div className="aya-search-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  result: SearchResult;
  selected: boolean;
  index: number;
  onClick: () => void;
  onMouseEnter: () => void;
}

function ResultRow({
  result,
  selected,
  index,
  onClick,
  onMouseEnter,
}: RowProps) {
  return (
    <div
      data-idx={index}
      className={`aya-search-row ${selected ? "aya-search-row--selected" : ""}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <span
        className="aya-search-icon"
        style={result.iconColor ? { color: result.iconColor } : undefined}
      >
        {result.icon}
      </span>
      <div className="aya-search-text">
        <div className="aya-search-label">{result.label}</div>
        {result.snippet ? (
          <SnippetWithHighlight
            text={result.snippet}
            start={result.matchStart ?? 0}
            length={result.matchLength ?? 0}
          />
        ) : (
          <div className="aya-search-secondary">{result.secondary}</div>
        )}
      </div>
      {result.moreOccurrences ? (
        <span
          className="aya-search-count"
          title={`${result.moreOccurrences + 1} matches in this terminal`}
        >
          +{result.moreOccurrences}
        </span>
      ) : (
        <span className="aya-search-secondary-right">
          {result.kind === "project" ? "project" : ""}
        </span>
      )}
    </div>
  );
}

function SnippetWithHighlight({
  text,
  start,
  length,
}: {
  text: string;
  start: number;
  length: number;
}) {
  if (length <= 0 || start < 0 || start + length > text.length) {
    return <div className="aya-search-secondary">{text}</div>;
  }
  return (
    <div className="aya-search-secondary aya-search-snippet">
      {text.slice(0, start)}
      <mark>{text.slice(start, start + length)}</mark>
      {text.slice(start + length)}
    </div>
  );
}
