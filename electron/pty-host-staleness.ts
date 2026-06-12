// Decides whether the running PTY host is "stale" - i.e. it belongs to an older
// Aya build than the one now in charge. The host is spawned detached and
// survives app quit/reinstall (by design - "PTYs survive restart"), so after an
// update the new app reconnects to the OLD host binary instead of a fresh one.
// Anything baked into the host (entitlements) or needing a fresh process then
// silently keeps using the old version (#28).
//
// Pure module so the comparison can be unit-tested without spawning anything.

/** Identity a host reports about the build it was launched from. Reported via
 *  the `version` handshake; an old host that predates the handshake returns an
 *  error, which the client maps to `null` (treated as stale below). */
export interface HostIdentity {
  /** App version from the host build's package.json. */
  version: string;
  /** sha256 of the host script the process is running. Distinguishes two
   *  builds that share a version number (e.g. a dev rebuild of 0.4.0) - the
   *  case a version check alone misses. */
  scriptHash: string;
}

/** True when the running host does not match what the current app would spawn.
 *  `actual === null` means the handshake failed (old host / no version
 *  support) - itself the strongest "stale" signal. Otherwise a difference in
 *  either the version or the script hash means a different build. */
export function isHostStale(
  expected: HostIdentity,
  actual: HostIdentity | null,
): boolean {
  if (actual === null) return true;
  return (
    actual.version !== expected.version ||
    actual.scriptHash !== expected.scriptHash
  );
}
