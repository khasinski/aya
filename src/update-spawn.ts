export const UPDATE_SPAWN_REFUSAL = "Aya is getting ready to restart for an update. This terminal wasn't started.";

/** Remove Electron's invoke wrapper before an IPC error is shown in the renderer. */
export function displayIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
