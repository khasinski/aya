// A termination signal (kill, a task runner's stop, Ctrl+C or a closed terminal
// in dev) is a quit nobody can answer a question for. Electron's own handler
// runs the ordinary quit, so a busy conversation turn's "Work in progress will
// stop" dialog vetoed it; the sender then escalated to SIGKILL, the terminal
// host transfer was never announced, and the next launch could not reattach a
// single pane (2026-11-26).
export const QUIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
export type QuitSignal = (typeof QUIT_SIGNALS)[number];

interface SignalTarget {
  on(signal: QuitSignal, listener: () => void): unknown;
  off(signal: QuitSignal, listener: () => void): unknown;
}

/** Routes each termination signal to `quit`, the ordinary quit flow minus its questions. Install it after app
 *  ready: Chromium installs its own shutdown handlers during startup, replacing a Node handler added earlier.
 *  The first signal also removes the handler, so a repeated signal terminates as it would without Aya's handler,
 *  the way Chromium's handler behaves. */
export function installQuitSignals(proc: SignalTarget, quit: (signal: QuitSignal) => void): void {
  for (const signal of QUIT_SIGNALS) {
    const listener = (): void => {
      proc.off(signal, listener);
      quit(signal);
    };
    proc.on(signal, listener);
  }
}
