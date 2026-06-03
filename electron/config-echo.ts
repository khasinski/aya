// Tells Aya's OWN config writes apart from external (hand) edits.
//
// Every writeFileAtomic records a hash of the bytes it just wrote, keyed by the
// absolute file path. The config watcher, on a filesystem change, reads the
// file and asks isEcho(): if the on-disk content hashes to what we last wrote,
// the event is the echo of our own save and must be ignored — otherwise the app
// would reload-storm on every in-app save. A hash that differs means the file
// was edited out-of-band, which is exactly what we want to react to.

import { createHash } from "node:crypto";

const lastWrittenHash = new Map<string, string>();

export function hashConfig(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

/** Record the content Aya just wrote to `filePath` so a subsequent watch event
 *  for byte-identical content is recognized as our own echo, not an edit. */
export function recordWrite(filePath: string, content: string): void {
  lastWrittenHash.set(filePath, hashConfig(content));
}

/** True if `content` is byte-identical to the last thing Aya wrote to
 *  `filePath` (the watch event is the echo of our own save). False if we never
 *  wrote that path or the content differs (a genuine external edit). */
export function isEcho(filePath: string, content: string): boolean {
  return lastWrittenHash.get(filePath) === hashConfig(content);
}
