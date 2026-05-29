// Search execution.
//
// Step 1 keeps the query parser deliberately small: tokens are split on
// whitespace and each token is either a literal word or a quoted phrase.
// Filters (project:, terminal:, etc.) come in step 3; for now callers pass
// filters as structured SearchQuery fields.
//
// FTS5's bm25 ranking is wrapped in a hand-rolled overlay so we can boost
// open / active / recent results without giving up on lexical recall.

import type Database from "better-sqlite3";
import type { SearchContext, SearchHit, SearchQuery } from "./types";

const DEFAULT_LIMIT = 100;

/** Wrap a token for safe inclusion in an FTS5 MATCH expression. Anything
 *  that isn't ASCII alphanumeric gets quoted; double quotes inside become
 *  the FTS5-required "" escape. Quoted phrases are passed through with
 *  their content re-escaped. */
function fts5Quote(token: string, isPhrase: boolean): string {
  const inner = token.replace(/"/g, '""');
  return isPhrase ? `"${inner}"` : /^[A-Za-z0-9_]+$/.test(token) ? token : `"${inner}"`;
}

/** Tokenize the user text into FTS5 MATCH form. Adjacent whitespace-
 *  separated tokens are AND'd by FTS5 default. */
export function buildMatchExpression(text: string): string {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) {
        tokens.push(fts5Quote(text.slice(i + 1), true));
        break;
      }
      const inner = text.slice(i + 1, end);
      if (inner.length > 0) tokens.push(fts5Quote(inner, true));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] !== " " && text[j] !== "\t" && text[j] !== "\n") j++;
    const token = text.slice(i, j);
    if (token.length > 0) tokens.push(fts5Quote(token, false));
    i = j;
  }
  return tokens.join(" ");
}

interface RawHit {
  lineId: number;
  sessionId: string;
  projectSlug: string;
  terminalId: string;
  presetId: string;
  cwd: string;
  kind: SearchHit["kind"];
  text: string;
  snippet: string;
  rank: number;
  createdAt: number;
  lineNo: number;
}

function buildFilterClauses(q: SearchQuery): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (q.projectSlugs && q.projectSlugs.length > 0) {
    const placeholders = q.projectSlugs.map((_, i) => `@p_proj_${i}`).join(",");
    where.push(`l.project_slug IN (${placeholders})`);
    q.projectSlugs.forEach((v, i) => (params[`p_proj_${i}`] = v));
  }
  if (q.terminalIds && q.terminalIds.length > 0) {
    const placeholders = q.terminalIds.map((_, i) => `@p_term_${i}`).join(",");
    where.push(`l.terminal_id IN (${placeholders})`);
    q.terminalIds.forEach((v, i) => (params[`p_term_${i}`] = v));
  }
  if (q.presets && q.presets.length > 0) {
    const placeholders = q.presets.map((_, i) => `@p_pre_${i}`).join(",");
    where.push(`l.preset_id IN (${placeholders})`);
    q.presets.forEach((v, i) => (params[`p_pre_${i}`] = v));
  }
  if (q.kinds && q.kinds.length > 0) {
    const placeholders = q.kinds.map((_, i) => `@p_kind_${i}`).join(",");
    where.push(`l.kind IN (${placeholders})`);
    q.kinds.forEach((v, i) => (params[`p_kind_${i}`] = v));
  }
  if (typeof q.since === "number") {
    where.push("l.created_at >= @p_since");
    params.p_since = q.since;
  }
  if (typeof q.until === "number") {
    where.push("l.created_at < @p_until");
    params.p_until = q.until;
  }

  return { where, params };
}

/** Apply the boosts described in search.md. FTS5 bm25 is negative; smaller
 *  (more negative) means a better match. Boosts multiply, with >1 making
 *  the rank more negative i.e. better. */
function applyRankingOverlay(
  hit: RawHit,
  ctx: SearchContext | undefined,
  now: number,
): number {
  let rank = hit.rank;
  if (ctx?.openProjectSlugs?.has(hit.projectSlug)) rank *= 1.5;
  if (ctx?.activeTerminalId && hit.terminalId === ctx.activeTerminalId) rank *= 2.0;

  const ageDays = (now - hit.createdAt) / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.max(0.5, 1 - ageDays / 365);
  rank *= recencyFactor;

  if (hit.kind === "status") rank *= 1.4;
  if (hit.kind === "screen" && ctx?.tuiPresets?.has(hit.presetId)) rank *= 1.5;

  return rank;
}

export interface SearchOptions {
  /** Bm25 column weights, in FTS5 column order: text, then the 5 UNINDEXED
   *  columns (which always contribute 0). Default ([1.0]) is fine for v1. */
  bm25Weights?: number[];
  /** "now" for recency calculations. Defaults to Date.now(). */
  now?: number;
}

/** Execute a search. Returns hits ordered by computed rank, ASC (smaller =
 *  better). Caller can present in that order or invert client-side. */
export function searchTerminalLines(
  db: Database.Database,
  query: SearchQuery,
  ctx?: SearchContext,
  opts: SearchOptions = {},
): SearchHit[] {
  const match = buildMatchExpression(query.text);
  if (match.length === 0) return [];

  const { where, params } = buildFilterClauses(query);
  const whereSql = where.length > 0 ? "AND " + where.join(" AND ") : "";
  const limit = query.limit ?? DEFAULT_LIMIT;
  params.p_match = match;
  // 4x the user limit lets the ranking overlay reshuffle a meaningfully
  // larger candidate set before truncating, without exploding cost.
  params.p_inner_limit = limit * 4;

  const sql = `
    SELECT
      l.id            AS lineId,
      l.session_id    AS sessionId,
      l.project_slug  AS projectSlug,
      l.terminal_id   AS terminalId,
      l.preset_id     AS presetId,
      l.cwd           AS cwd,
      l.kind          AS kind,
      l.text          AS text,
      l.line_no       AS lineNo,
      l.created_at    AS createdAt,
      snippet(terminal_lines_fts, 0, '<mark>', '</mark>', '...', 12) AS snippet,
      bm25(terminal_lines_fts) AS rank
    FROM terminal_lines_fts
    JOIN terminal_lines l ON l.id = terminal_lines_fts.rowid
    WHERE terminal_lines_fts MATCH @p_match
    ${whereSql}
    ORDER BY rank
    LIMIT @p_inner_limit
  `;

  const raw = db.prepare(sql).all(params) as RawHit[];
  const now = opts.now ?? Date.now();
  const reranked = raw
    .map((h) => ({ hit: h, score: applyRankingOverlay(h, ctx, now) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({
      lineId: hit.lineId,
      sessionId: hit.sessionId,
      projectSlug: hit.projectSlug,
      terminalId: hit.terminalId,
      presetId: hit.presetId,
      cwd: hit.cwd,
      kind: hit.kind,
      text: hit.text,
      snippet: hit.snippet,
      rank: score,
      createdAt: hit.createdAt,
      lineNo: hit.lineNo,
    }));
  return reranked;
}
