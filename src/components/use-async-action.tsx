import { useCallback, useState } from "react";

/** The error text without Electron's "Error invoking remote method" wrapper. */
function ipcMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** Runs one IPC action at a time: busy while it runs, its error (without
 *  Electron's wrapper) after it fails, and its result when it succeeds. */
export function useAsyncAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setBusy(true);
    try {
      return await work();
    } catch (err) {
      setError(ipcMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="aya-teams-error">{error}</div> : null;
}
