import { matchesBoardQuery } from "../../shared/board-query.cjs";
import type { KanbanCard } from "../types";

/** The board filter and the shelf search: shared/board-query.cjs, the query language
 *  `aya board search` uses too. `isArchivedCard` says whether the card is in the archive;
 *  without it, the card's archivedAt says. */
export function matchesSearchQuery(card: KanbanCard, query: string, isArchivedCard?: boolean): boolean {
  return matchesBoardQuery(card, query, isArchivedCard);
}
