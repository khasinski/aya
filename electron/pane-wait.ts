import type { PaneStateResult } from "./pane-state";

export type PaneWaitCondition = "idle" | "waiting" | "exited";
export const PANE_WAIT_DEFAULT_TIMEOUT_MS = 30_000;

export interface PaneWaitTarget {
  terminalId: string;
  name: string;
}

export interface PaneWaitResult {
  met: boolean;
  matched: string[];
  pending: string[];
}

export interface PaneWaitOptions {
  until: PaneWaitCondition[];
  any: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  readState: (terminalId: string) => Promise<PaneStateResult>;
  subscribe: (terminalId: string, listener: (state: PaneStateResult) => void) => () => void;
}

export function paneWaitMatches(state: PaneStateResult, until: readonly PaneWaitCondition[]): boolean {
  return until.some((condition) => {
    if (condition === "idle") return state.state === "idle" || state.state === "shell";
    if (condition === "waiting") return state.waiting === true;
    return state.state === "stopped";
  });
}

/** Latches state transitions from the host's existing applied-snapshot/event stream. */
export async function waitForPaneTargets(
  targets: PaneWaitTarget[],
  options: PaneWaitOptions,
): Promise<PaneWaitResult> {
  const matched = new Set<string>();
  const unsubscribers: Array<() => void> = [];
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  return new Promise<PaneWaitResult>((resolve) => {
    let settled = false;
    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      for (const unsubscribe of unsubscribers) unsubscribe();
      const names = targets.filter((target) => matched.has(target.terminalId)).map((target) => target.name);
      const pending = targets.filter((target) => !matched.has(target.terminalId)).map((target) => target.name);
      resolve({ met: !timedOut, matched: options.any ? names.slice(0, 1) : names, pending });
    };
    const update = (target: PaneWaitTarget, state: PaneStateResult) => {
      if (settled || !paneWaitMatches(state, options.until)) return;
      matched.add(target.terminalId);
      if ((options.any && matched.size > 0) || (!options.any && matched.size === targets.length)) finish(false);
    };

    if (options.signal?.aborted) return finish(true);
    for (const target of targets) unsubscribers.push(options.subscribe(target.terminalId, (state) => update(target, state)));
    abortListener = () => finish(true);
    options.signal?.addEventListener("abort", abortListener, { once: true });
    timer = setTimeout(() => finish(true), options.timeoutMs);
    void Promise.all(targets.map(async (target) => {
      try { update(target, await options.readState(target.terminalId)); } catch { /* unavailable is not a met condition */ }
    }));
  });
}

export function formatPaneWaitReply(
  result: PaneWaitResult,
  targets: PaneWaitTarget[],
  until: readonly PaneWaitCondition[],
  timeoutMs: number,
): { output: string; exitCode: 0 | 1 } {
  if (result.met) {
    const names = result.matched.map((name) => `"${name}"`).join(", ");
    return { output: `Reached ${until.join(" or ")} for ${names}.\n`, exitCode: 0 };
  }
  const still = targets.filter((target) => result.pending.includes(target.name));
  const condition = until.join(" or ");
  const seconds = timeoutMs / 1000;
  return {
    output: `Timed out after ${seconds} seconds. Still waiting for ${still.map((target) => `"${target.name}" to be ${condition}`).join(", ")}.\n`,
    exitCode: 1,
  };
}
