// Public types for the search substrate. Kept separate so renderer-side code
// can import them without pulling better-sqlite3 in.

export type LineKind = "output" | "screen" | "scrollback" | "status";

export interface SessionKey {
  /** Stable identifier for this PTY lifetime. New session on every restart. */
  id: string;
  terminalId: string;
  projectSlug: string;
  presetId: string;
  cwd: string;
}

export interface SearchQuery {
  /** User-typed query. Will be tokenized and turned into an FTS5 MATCH. */
  text: string;
  projectSlugs?: string[];
  terminalIds?: string[];
  presets?: string[];
  kinds?: LineKind[];
  /** Inclusive lower bound, unix ms. */
  since?: number;
  /** Exclusive upper bound, unix ms. */
  until?: number;
  /** Default 100. */
  limit?: number;
}

export interface SearchHit {
  lineId: number;
  sessionId: string;
  projectSlug: string;
  terminalId: string;
  presetId: string;
  cwd: string;
  kind: LineKind;
  /** Raw line text, not snippet. */
  text: string;
  /** FTS5 snippet with <mark>...</mark> around matches. */
  snippet: string;
  /** bm25 score, lower is better. Already includes the ranking overlay. */
  rank: number;
  createdAt: number;
  lineNo: number;
}

/** Context passed to the query layer so the ranking overlay can boost open /
 *  active projects and terminals without reaching into renderer state from
 *  electron/main. */
export interface SearchContext {
  openProjectSlugs?: ReadonlySet<string>;
  activeTerminalId?: string | null;
  /** Presets considered TUI for the screen-vs-output rank boost. */
  tuiPresets?: ReadonlySet<string>;
}
