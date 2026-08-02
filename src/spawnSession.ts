// Tracks per-terminal spawn knowledge for this renderer session. Drives the
// mount-time spawn decision in TerminalView: attach to what the host already
// has instead of silently spawning a fresh (contextless) process, and only
// spawn fresh when that is what the user (or a cold boot) actually asked for.
//
// Three module-scoped sets - they survive TerminalView remounts and reset on a
// full renderer reload so first-boot auto-start stays normal:
//
// - `spawned`: ids with a CONFIRMED live session (a `data` event arrived).
//   Keyed on confirmed output, NOT on the spawn request - an in-flight first
//   spawn that re-mounts before any output is treated as a first spawn (no
//   false "no-session"), and an explicit restart of a not-yet-confirmed tab
//   still spawns.
// - `noSession`: ids the host answered `no-session` for - the tab is showing
//   the stopped/restartable state. A later re-mount must attach-only again
//   (and stay stopped) rather than surprise-respawn on a project switch.
// - `mountDecided`: ids whose FIRST mount-time spawn decision already
//   happened. Gates the boot-only `attachIfReused` intent to exactly one
//   attempt per renderer session: without it, a re-mount after an explicit
//   restart of an unmounted tab would probe attach again on a reused host,
//   get `no-session`, and leave the user's requested restart stuck stopped.

const spawned = new Set<string>();
const noSession = new Set<string>();
const mountDecided = new Set<string>();

/** Mark a terminal as having a confirmed live session (called on PTY output). */
export function markSpawned(id: string): void {
  spawned.add(id);
}

/** True if this terminal already produced a session this renderer session, so a
 *  re-mount should attach-only rather than spawn fresh. */
export function wasSpawned(id: string): boolean {
  return spawned.has(id);
}

/** Mark a terminal the host reported `no-session` for (its PTY is gone and the
 *  tab shows stopped/restartable). Called by the PTY event router. */
export function markNoSession(id: string): void {
  noSession.add(id);
}

/** True if the host already told us this terminal has no session - a re-mount
 *  must keep it stopped (attach-only) instead of silently respawning. */
export function hadNoSession(id: string): boolean {
  return noSession.has(id);
}

/** Record that a TerminalView mount made its spawn decision for this id. */
export function markMountDecided(id: string): void {
  mountDecided.add(id);
}

/** True once the first mount-time spawn decision for this id happened - the
 *  boot-only attachIfReused intent must not fire again after that. */
export function wasMountDecided(id: string): boolean {
  return mountDecided.has(id);
}

/** Forget everything that would make the next mount attach instead of spawn.
 *  Called on an explicit (re)start whose target tab may be unmounted - the
 *  host just killed the PTY (or it was already gone), so an attach-only mount
 *  would wrongly report no-session and leave the user's requested restart
 *  stuck as stopped. Also CLOSES the boot attach window (marks the mount
 *  decision as made) - an explicit restart outranks the boot-time "attach to
 *  a reused host" intent. */
export function forgetSpawn(id: string): void {
  spawned.delete(id);
  noSession.delete(id);
  mountDecided.add(id);
}
