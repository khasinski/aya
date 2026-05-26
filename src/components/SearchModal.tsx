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
  activeProject: ProjectConfig | null;
  terminals: Record<string, TerminalState>;
  presets: Preset[];
  /** Map of terminalId → ms timestamp of last PTY data, for ranking the
   *  default (empty-query) list by recency. */
  lastActivity: Record<string, number>;
  onSelectProject: (slug: string) => void;
  onSelectTerminal: (slug: string, terminalId: string) => void;
  onRunPreset: (presetId: string) => void;
  onClose: () => void;
}

export interface SearchResult {
  kind: "project" | "terminal" | "launcher";
  projectSlug: string;
  terminalId?: string;
  presetId?: string;
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

/** Per-token score against a project name. Returns 0 if the token doesn't
 *  match anywhere — caller treats that as "this token disqualifies the
 *  whole item" in AND-matching. */
function scoreTokenAgainstProject(name: string, tok: string): number {
  const n = name.toLowerCase();
  if (n === tok) return 1000;
  if (n.startsWith(tok)) return 500;
  if (n.includes(tok)) return 200;
  return 0;
}
/** Per-token score against a terminal name. */
function scoreTokenAgainstTerminal(name: string, tok: string): number {
  const n = name.toLowerCase();
  if (n === tok) return 500;
  if (n.startsWith(tok)) return 250;
  if (n.includes(tok)) return 100;
  return 0;
}

/** All tokens must score > 0 against the project name. Returns sum or 0. */
function projectAllTokens(name: string, tokens: string[]): number {
  let total = 0;
  for (const tok of tokens) {
    const s = scoreTokenAgainstProject(name, tok);
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

/** A terminal "matches" if every token matches either its own name or its
 *  project's name (the user thinks of terminals as "claude in ruby", so
 *  the project name is part of the terminal's identity in search). */
function terminalAllTokens(
  terminalName: string,
  projectName: string,
  tokens: string[],
): number {
  let total = 0;
  for (const tok of tokens) {
    const t = scoreTokenAgainstTerminal(terminalName, tok);
    const p = scoreTokenAgainstProject(projectName, tok);
    const best = Math.max(t, p);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function launcherAllTokens(preset: Preset, tokens: string[]): number {
  let total = 0;
  const haystacks = [
    { value: "run", exact: 800, prefix: 400, contains: 120 },
    { value: preset.name, exact: 700, prefix: 350, contains: 100 },
    { value: preset.command, exact: 500, prefix: 250, contains: 80 },
  ];
  for (const tok of tokens) {
    let best = 0;
    for (const h of haystacks) {
      const value = h.value.toLowerCase();
      if (value === tok) best = Math.max(best, h.exact);
      else if (value.startsWith(tok)) best = Math.max(best, h.prefix);
      else if (value.includes(tok)) best = Math.max(best, h.contains);
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function buildResults(
  query: string,
  projects: ProjectConfig[],
  activeProject: ProjectConfig | null,
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

  // Split the query into whitespace-delimited tokens. Every token must
  // match somewhere on an item for it to qualify (AND semantics) —
  // "ruby codex" finds a "codex" terminal inside a "ruby" project even
  // though no single substring contains both words.
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);

  if (activeProject) {
    for (const preset of presets) {
      const s = launcherAllTokens(preset, tokens);
      if (s > 0) {
        out.push({
          kind: "launcher",
          projectSlug: activeProject.slug,
          presetId: preset.id,
          label: `Run ${preset.name}`,
          secondary: `New terminal in ${activeProject.name}`,
          icon: preset.icon,
          iconColor: preset.color || undefined,
          score: s + 25,
        });
      }
    }
  }

  // Project name matches: every token must match the project name.
  for (const p of projects) {
    const s = projectAllTokens(p.name, tokens);
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

  // Terminal matches: every token must match either the terminal's own
  // name or its project's name.
  const tnMatched = new Set<string>();
  for (const t of Object.values(terminals)) {
    const project = projects.find((p) => p.slug === t.projectSlug);
    const s = terminalAllTokens(t.name, project?.name ?? "", tokens);
    if (s > 0) {
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
  activeProject,
  terminals,
  presets,
  lastActivity,
  onSelectProject,
  onSelectTerminal,
  onRunPreset,
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
        activeProject,
        terminals,
        presets,
        lastActivity,
        contentHits,
      ),
    [
      query,
      projects,
      activeProject,
      terminals,
      presets,
      lastActivity,
      contentHits,
    ],
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
    if (r.kind === "launcher" && r.presetId) {
      onRunPreset(r.presetId);
    } else if (r.kind === "terminal" && r.terminalId) {
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
                key={`${r.kind}-${r.projectSlug}-${r.terminalId ?? r.presetId ?? "_"}-${i}`}
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
          {result.kind === "project"
            ? "project"
            : result.kind === "launcher"
              ? "run"
              : ""}
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
