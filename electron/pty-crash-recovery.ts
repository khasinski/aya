// Main owns recovery. A retry is allowed only after the caller has proved the
// failed JS process gone; an uncertain cleanup stops recovery, never overlaps it.
export type RecoveryAttemptResult = "recovered" | "retry" | "blocked";
export interface CrashRecoveryPolicy {
  delays: readonly number[];
  attemptTimeoutMs: number;
  stableMs: number;
}
export const CRASH_RECOVERY_POLICY: CrashRecoveryPolicy = {
  delays: [100, 500, 1500], attemptTimeoutMs: 10_000, stableMs: 120_000,
};
export interface CrashRecoveryDeps {
  attempt(signal: AbortSignal): Promise<RecoveryAttemptResult>;
  state(state: "recovering" | "recovered" | "exhausted"): void;
  now?: () => number;
  policy?: CrashRecoveryPolicy;
}
/** The budget spans successful reconnects too: repeated short-lived hosts must
 * not reset it into a permanent restart loop. Only a stable interval resets it. */
export class PtyCrashRecovery {
  private readonly policy: CrashRecoveryPolicy;
  private readonly now: () => number;
  private used = 0;
  private stableSince: number | null = null;
  private active: Promise<boolean> | null = null;
  private controller: AbortController | null = null;
  private disposed = false;
  private exhausted = false;
  constructor(private readonly deps: CrashRecoveryDeps) {
    this.policy = deps.policy ?? CRASH_RECOVERY_POLICY;
    this.now = deps.now ?? Date.now;
  }
  recover(): Promise<boolean> {
    if (this.disposed || this.exhausted) return Promise.resolve(false);
    if (this.active) return this.active;
    if (this.stableSince !== null && this.now() - this.stableSince >= this.policy.stableMs) this.used = 0;
    this.stableSince = null;
    const controller = new AbortController(); this.controller = controller;
    // Defer work so active is installed even if cancellation is synchronous.
    const run = Promise.resolve().then(() => this.run(controller.signal));
    this.active = run.finally(() => {
      if (this.controller === controller) this.controller = null;
      this.active = null;
    });
    return this.active;
  }
  dispose(): void { this.disposed = true; this.controller?.abort(); }
  private async run(signal: AbortSignal): Promise<boolean> {
    this.deps.state("recovering");
    while (!signal.aborted && this.used < this.policy.delays.length) {
      const delay = this.policy.delays[this.used++];
      if (!await pause(delay, signal)) return false;
      const attempt = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let stop!: () => void;
      // Register cancellation before invoking user code. A callback may cancel
      // synchronously, or settle its work synchronously when abort is notified.
      const interruption = new Promise<RecoveryAttemptResult>(resolve => {
        stop = () => { stopped = true; resolve("blocked"); attempt.abort(); };
        timer = setTimeout(stop, this.policy.attemptTimeoutMs);
      });
      signal.addEventListener("abort", stop, {once: true});
      let result: RecoveryAttemptResult;
      try {
        if(signal.aborted)stop();
        result = stopped ? "blocked" : await Promise.race([interruption, this.deps.attempt(attempt.signal)]);
        // The timeout decision cannot be undone by an abort listener resolving
        // the attempt as retry/recovered before its rejection is observed.
        if(stopped)result="blocked";
      } catch { result = "blocked"; }
      finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
      if (signal.aborted || this.disposed) return false;
      if (result === "recovered") { this.stableSince = this.now(); this.deps.state("recovered"); return true; }
      if (result === "blocked") break;
    }
    if (!signal.aborted && !this.disposed) { this.exhausted = true; this.deps.state("exhausted"); }
    return false;
  }
}
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const done = (ok: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(ok); };
    const abort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", abort, {once: true});
  });
}
