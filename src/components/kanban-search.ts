import { PRIORITY_QUERY_TOKENS, PRIORITY_SHORT_TOKENS } from "../../shared/board-priorities.cjs";
import type { KanbanCard } from "../types";

/** The board filter's query language, shared by the board filter and the archive shelf search:
 *  #label, label:/tag:, @owner, assignee:/owner:, p0-p3, p:/priority:, col:/column:,
 *  is:archived/in:archive, is:active/is:open, is:claimed, is:unassigned, and free text.
 *  Every token must match. An empty query matches every card. */
export function matchesSearchQuery(card: KanbanCard, query: string, isArchivedCard?: boolean): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const isArchived =
    typeof isArchivedCard === "boolean"
      ? isArchivedCard
      : Boolean(card.archivedAt);
  const tokens = q.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (token.startsWith("#") && token.length > 1) {
      const needle = token.slice(1);
      if (!card.labels?.some((l) => l.toLowerCase().includes(needle)))
        return false;
      continue;
    }
    if (
      (token.startsWith("label:") || token.startsWith("tag:")) &&
      token.includes(":")
    ) {
      const needle = token.slice(token.indexOf(":") + 1);
      if (needle && !card.labels?.some((l) => l.toLowerCase().includes(needle)))
        return false;
      continue;
    }
    if (token.startsWith("@") && token.length > 1) {
      const needle = token.slice(1);
      const assigneeMatch =
        card.assignee?.toLowerCase().includes(needle) ?? false;
      const claimMatch =
        card.claim?.paneName.toLowerCase().includes(needle) ?? false;
      if (!assigneeMatch && !claimMatch) return false;
      continue;
    }
    if (token.startsWith("assignee:") || token.startsWith("owner:")) {
      const needle = token.slice(token.indexOf(":") + 1);
      if (needle) {
        const assigneeMatch =
          card.assignee?.toLowerCase().includes(needle) ?? false;
        const claimMatch =
          card.claim?.paneName.toLowerCase().includes(needle) ?? false;
        if (!assigneeMatch && !claimMatch) return false;
      }
      continue;
    }
    if (PRIORITY_SHORT_TOKENS.includes(token)) {
      if (card.priority !== PRIORITY_QUERY_TOKENS[token]) return false;
      continue;
    }
    if (token.startsWith("p:") || token.startsWith("priority:")) {
      const rawP = token.slice(token.indexOf(":") + 1);
      if (rawP) {
        const mapped = PRIORITY_QUERY_TOKENS[rawP];
        if (mapped) {
          if (card.priority !== mapped) return false;
        } else if ((card.priority?.toLowerCase() ?? "") !== rawP) {
          return false;
        }
      }
      continue;
    }
    if (token.startsWith("col:") || token.startsWith("column:")) {
      const needle = token.slice(token.indexOf(":") + 1);
      if (needle && !card.columnId.toLowerCase().includes(needle))
        return false;
      continue;
    }
    if (token === "is:archived" || token === "in:archive") {
      if (!isArchived) return false;
      continue;
    }
    if (token === "is:active" || token === "is:open") {
      if (isArchived) return false;
      continue;
    }
    if (token === "is:claimed") {
      if (!card.claim) return false;
      continue;
    }
    if (token === "is:unassigned") {
      if (card.claim || card.assignee) return false;
      continue;
    }
    const matchesFreeText =
      card.id.toLowerCase().includes(token) ||
      card.title.toLowerCase().includes(token) ||
      (card.description?.toLowerCase().includes(token) ?? false) ||
      card.columnId.toLowerCase().includes(token) ||
      (card.assignee?.toLowerCase().includes(token) ?? false) ||
      (card.claim?.paneName.toLowerCase().includes(token) ?? false) ||
      (card.priority?.toLowerCase().includes(token) ?? false) ||
      (card.labels?.some((l) => l.toLowerCase().includes(token)) ?? false);
    if (!matchesFreeText) return false;
  }
  return true;
}
