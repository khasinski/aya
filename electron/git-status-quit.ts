interface BeforeQuitEvent {
  preventDefault(): void;
}

interface QuitApp {
  on(event: "before-quit", listener: (event: BeforeQuitEvent) => void): void;
  removeListener(event: "before-quit", listener: (event: BeforeQuitEvent) => void): void;
  quit(): void;
}

/** Hold a real quit only while an owned Git status child needs cleanup. */
export function registerGitStatusQuitGuard(
  app: QuitApp,
  deps: {
    hasPendingChildren: () => boolean;
    teardown: () => Promise<void>;
    onError?: (error: unknown) => void;
  },
): void {
  let teardownStarted = false;
  let teardownComplete = false;
  const holdQuit = (event: BeforeQuitEvent) => {
    if (teardownComplete) return;
    // This check is synchronous with child registration. Synthetic before-quit
    // notifications and ordinary quits with no status child pass through.
    if (!teardownStarted && !deps.hasPendingChildren()) return;
    event.preventDefault();
    if (teardownStarted) return;
    teardownStarted = true;
    void deps.teardown().catch((error) => {
      deps.onError?.(error);
    }).finally(() => {
      teardownComplete = true;
      app.removeListener("before-quit", holdQuit);
      app.quit();
    });
  };
  app.on("before-quit", holdQuit);
}
