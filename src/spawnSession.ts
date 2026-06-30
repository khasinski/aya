// Tracks terminal ids that have produced a CONFIRMED live PTY session in this
// renderer session. Drives attach-only re-mounts: a tab that already ran and
// whose process is now gone surfaces a stopped state instead of silently
// spawning a fresh (contextless) process.
//
// Keyed on confirmed output (a `data` event), NOT on the spawn request - so an
// in-flight first spawn that re-mounts before any output is treated as a first
// spawn (no false "no-session"), and an explicit restart of a not-yet-confirmed
// tab still spawns. Module-scoped: survives TerminalView remounts, resets on a
// full renderer reload so first-boot auto-start is normal.

const spawned = new Set<string>();

/** Mark a terminal as having a confirmed live session (called on PTY output). */
export function markSpawned(id: string): void {
  spawned.add(id);
}

/** True if this terminal already produced a session this renderer session, so a
 *  re-mount should attach-only rather than spawn fresh. */
export function wasSpawned(id: string): boolean {
  return spawned.has(id);
}

/** Forget a terminal so its next mount spawns normally instead of attaching.
 *  Called on an explicit (re)start whose target tab may be unmounted - the host
 *  just killed the PTY, so an attach-only mount would wrongly report no-session
 *  and leave the user's requested restart stuck as stopped. */
export function forgetSpawn(id: string): void {
  spawned.delete(id);
}
