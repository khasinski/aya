// Database connection management. One database per Aya home.
//
// We deliberately keep this module thin: open, configure pragmas, run
// migrations, hand the handle back. Higher-level concerns (indexing,
// querying, pruning) sit in their own modules and accept a Database.

import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { runMigrations } from "./schema";

export interface OpenOptions {
  /** Absolute path to the .sqlite file. ":memory:" is allowed for tests. */
  filePath: string;
  /** If true, opens read-only. Defaults to false. */
  readonly?: boolean;
}

/** Open (or create) a search database, apply migrations, and configure
 *  pragmas for our write-heavy + read-occasional workload. */
export function openSearchDatabase(opts: OpenOptions): Database.Database {
  if (opts.filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(opts.filePath), { recursive: true });
  }
  const db = new Database(opts.filePath, { readonly: opts.readonly ?? false });

  // WAL is non-negotiable: writes from the indexer must not block queries
  // from the renderer. NORMAL sync trades a tiny crash-recovery window for
  // significantly less fsync pressure under steady-state load.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // 64MB page cache. Cheap relative to terminal data size.
  db.pragma("cache_size = -65536");
  // 30s busy timeout absorbs the rare write contention without surfacing
  // SQLITE_BUSY to the renderer.
  db.pragma("busy_timeout = 30000");

  runMigrations(db);
  return db;
}

/** Close gracefully, checkpointing the WAL so the .sqlite file is up-to-date
 *  on disk. Safe to call multiple times. */
export function closeSearchDatabase(db: Database.Database): void {
  if (!db.open) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore — happens if the DB is already closing
  }
  db.close();
}
