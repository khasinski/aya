/** The error text without Electron's "Error invoking remote method" wrapper. */
export function ipcMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
