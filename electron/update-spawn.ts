export const UPDATE_SPAWN_REFUSAL = "Aya is getting ready to restart for an update. This terminal wasn't started.";

const HANDOVER_IN_PROGRESS = "Terminal handover is in progress";

/** All terminal creation paths share the PTY host, so translate its update freeze refusal once. */
export function userFacingSpawnError(error: unknown): Error {
  if (error instanceof Error && error.message.includes(HANDOVER_IN_PROGRESS)) {
    return new Error(UPDATE_SPAWN_REFUSAL);
  }
  return error instanceof Error ? error : new Error(String(error));
}
