// Process-singleton wrapper for the search substrate.
//
// One database, one indexer, owned by the main process. initSearch() is
// called once from main during app startup; shutdownSearch() runs on
// before-quit and flushes any pending batched writes.

import type Database from "better-sqlite3";
import * as path from "node:path";
import { AYA_HOME } from "../paths";
import { closeSearchDatabase, openSearchDatabase } from "./db";
import { SearchIndexer } from "./indexer";
import { searchTerminalLines } from "./query";
import type { SearchContext, SearchHit, SearchQuery } from "./types";

let db: Database.Database | null = null;
let indexer: SearchIndexer | null = null;

/** Open the DB and create the indexer. Safe to call multiple times. */
export function initSearch(): void {
  if (db) return;
  db = openSearchDatabase({
    filePath: path.join(AYA_HOME, "terminal-search.sqlite"),
  });
  indexer = new SearchIndexer(db);
}

/** Flush + close. Safe to call before init or twice. */
export function shutdownSearch(): void {
  if (indexer) {
    indexer.flushAll();
    indexer = null;
  }
  if (db) {
    closeSearchDatabase(db);
    db = null;
  }
}

/** Returns null if init hasn't been called. Callers should treat that as a
 *  silent no-op so test environments and the early-startup window don't
 *  throw. */
export function getIndexer(): SearchIndexer | null {
  return indexer;
}

/** Read-only access to the underlying database. Returns null before init. */
export function getSearchDb(): Database.Database | null {
  return db;
}

/** Convenience wrapper around the query module for callers that don't want
 *  to thread the db handle through their own code. */
export function search(query: SearchQuery, ctx?: SearchContext): SearchHit[] {
  if (!db) return [];
  return searchTerminalLines(db, query, ctx);
}

export type { SearchContext, SearchHit, SearchQuery } from "./types";
