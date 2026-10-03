// Decides whether the running PTY host is "stale" - i.e. it belongs to an older
// Aya build than the one now in charge. The host is spawned detached and
// survives app quit/reinstall (by design - "PTYs survive restart"), so after an
// update the new app reconnects to the OLD host binary instead of a fresh one.
// Anything baked into the host (entitlements) or needing a fresh process then
// silently keeps using the old version (#28).
//
// The comparison is pure; the build hash reads the built files, nothing spawned.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// The host's entry script, as the client launches it and the sweep recognises it.
export const PTY_HOST_SCRIPT_NAME = "pty-host.js";
// The client runs the host with ELECTRON_RUN_AS_NODE=1; the sweep checks for it.
export const RUN_AS_NODE_VAR = "ELECTRON_RUN_AS_NODE";
export const RUN_AS_NODE_VALUE = "1";
// A scriptHash that could not be read. The reaper never kills on it.
export const UNKNOWN_SCRIPT_HASH = "unknown";

/** The build a host was launched from, from the `version` handshake; a host predating it errors, which the
 *  client maps to null (stale). */
export interface HostIdentity {
  /** App version from the host build's package.json. */
  version: string;
  /** sha256 of the host script the process is running. Distinguishes two
   *  builds that share a version number (e.g. a dev rebuild of 0.4.0) - the
   *  case a version check alone misses. */
  scriptHash: string;
}

/** A different version is "stale"; hashes compare only when both are known, else "indeterminate"
 *  (the "unknown" sentinel would trust a foreign build or condemn a healthy one). */
export function classifyIdentity(
  expected: { version: string; scriptHash: string },
  actual: { version: string; scriptHash: string },
): "compatible" | "stale" | "indeterminate" {
  if (actual.version !== expected.version) return "stale";
  if (actual.scriptHash === UNKNOWN_SCRIPT_HASH || expected.scriptHash === UNKNOWN_SCRIPT_HASH) {
    return "indeterminate";
  }
  return actual.scriptHash === expected.scriptHash ? "compatible" : "stale";
}

/** True when the running host is stale; `actual === null` (failed handshake) is the strongest signal.
 *  An indeterminate identity is not stale: restarting the host kills every agent in it. */
export function isHostStale(
  expected: HostIdentity,
  actual: HostIdentity | null,
): boolean {
  return actual === null || classifyIdentity(expected, actual) === "stale";
}

/** Every file the host runs from `dir`: its entry and the relative modules it
 *  requires inside `dir`, followed through, sorted. Read from the built CommonJS. */
export function hostModuleFiles(dir: string, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(path.join(dir, file), "utf-8");
    for (const m of source.matchAll(/require\("(\.\.?\/[\w./-]+?)(?:\.js)?"\)/g)) {
      // Resolved against the requiring file; a module outside `dir` is not the host's.
      const rel = path.relative(dir, path.resolve(dir, path.dirname(file), m[1]));
      if (rel.split(path.sep)[0] !== "..") visit(`${rel}.js`);
    }
  };
  visit(entry);
  return [...seen].sort();
}

/** One hash over the host's own files, so a change in any module it runs
 *  (not only its entry) marks a running host as another build. */
export function hostBuildHash(dir: string, entry: string): string {
  const hash = crypto.createHash("sha256");
  for (const file of hostModuleFiles(dir, entry)) {
    hash.update(file).update("\0").update(fs.readFileSync(path.join(dir, file))).update("\0");
  }
  return hash.digest("hex");
}
