// Helps us tell the app's own config saves apart from edits made by hand.
//
// Every atomic write stores a hash of the content it just wrote, keyed by the
// file path. When the config watcher sees a file change, it reads the file and
// calls isEcho(): if the content matches what we last wrote, the change came
// from us and we skip it, otherwise the app would reload on every save it makes
// itself. If the content is different, someone edited the file outside the app,
// which is exactly what we want to pick up.

import { createHash } from "node:crypto";

const lastWrittenHash = new Map<string, string>();

export function hashConfig(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** Remember the content we just wrote to `filePath`, so when the watcher sees
 *  the same content come back we know it was our own save, not an edit. */
export function recordWrite(filePath: string, content: string): void {
  lastWrittenHash.set(filePath, hashConfig(content));
}

/** True if `content` is exactly what we last wrote to `filePath`, i.e. the
 *  change came from our own save. False if we never wrote that file, or its
 *  content is different because someone edited it outside the app. */
export function isEcho(filePath: string, content: string): boolean {
  return lastWrittenHash.get(filePath) === hashConfig(content);
}
