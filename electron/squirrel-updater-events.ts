import type { EventEmitter } from "node:events";

export type NativeSquirrelUpdater = Pick<EventEmitter, "on" | "removeListener" | "listeners">;

function subscribe(updater: NativeSquirrelUpdater, event: string, listener: Function): () => void {
  const eventListener = listener as (...args: any[]) => void;
  updater.on(event, eventListener);
  return () => updater.removeListener(event, eventListener);
}

/** Production adapter for the three native Electron updater events used by Squirrel. */
export function attachSquirrelUpdaterEvents(
  updater: NativeSquirrelUpdater,
) {
  return {
    onUpdateDownloaded: (listener: () => void) => subscribe(updater, "update-downloaded", listener),
    onError: (listener: (error: unknown) => void) => subscribe(updater, "error", listener),
    onBeforeQuitForUpdate: (listener: () => void) => subscribe(updater, "before-quit-for-update", listener),
    captureHandoffListeners: () => captureNewUpdateDownloadedListeners(updater),
  };
}

/** Capture a baseline before MacUpdater.quitAndInstall(), then remove only its newly-added
 * update-downloaded handler if Aya's bounded handoff attempt fails. */
export function captureNewUpdateDownloadedListeners(updater: NativeSquirrelUpdater): () => void {
  const previous = new Set(updater.listeners("update-downloaded"));
  return () => {
    for (const listener of updater.listeners("update-downloaded")) {
      if (!previous.has(listener)) updater.removeListener("update-downloaded", listener as (...args: any[]) => void);
    }
  };
}

/** Remove URL credentials and query values from updater errors before they reach diagnostics. */
export function redactUpdaterError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, "$1=[redacted]")
    .slice(0, 500);
}
