import type { PaneStateResult } from "./pane-state";

// "busy" is internal: the CLI offers idle, waiting and exited. A send --wait uses it to see the agent start.
export type PaneWaitCondition = "idle" | "waiting" | "exited" | "busy";
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
    if (condition === "busy") return state.state === "busy";
    return state.exited === true;
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

/** How long a send --wait gives the agent to start working before it takes an idle pane for a finished one. */
export const PANE_SEND_START_GRACE_MS = 10_000;

export interface PaneSettleResult {
  outcome: "idle" | "waiting" | "exited" | "timeout";
  /** False when the pane never left idle after the send: the answer may have been instant, or the prompt ignored. */
  started: boolean;
}

/**
 * After a send: wait for the pane to start working, then for it to settle (idle, waiting for input or exited).
 * A pane that is still idle right after the send is not "done", so settling is only believed once work was seen,
 * or once the start grace passed without any.
 */
export async function waitForPaneToSettle(
  target: PaneWaitTarget,
  options: Omit<PaneWaitOptions, "until" | "any"> & { startGraceMs?: number },
): Promise<PaneSettleResult> {
  const deadline = Date.now() + options.timeoutMs;
  const grace = Math.min(options.startGraceMs ?? PANE_SEND_START_GRACE_MS, options.timeoutMs);
  const common = { signal: options.signal, readState: options.readState, subscribe: options.subscribe };
  const began = await waitForPaneTargets([target], { ...common, until: ["busy", "waiting", "exited"], any: true, timeoutMs: grace });
  const settled = await waitForPaneTargets([target], {
    ...common, until: ["idle", "waiting", "exited"], any: true, timeoutMs: Math.max(0, deadline - Date.now()),
  });
  if (!settled.met) return { outcome: "timeout", started: began.met };
  const last = await options.readState(target.terminalId).catch(() => null);
  const outcome = last?.exited ? "exited" : last?.waiting ? "waiting" : "idle";
  return { outcome, started: began.met };
}

export function formatPaneSendWaitReply(
  result: PaneSettleResult,
  name: string,
  timeoutMs: number,
): { output: string; exitCode: 0 | 1 } {
  const quoted = `"${name}"`;
  if (result.outcome === "timeout") {
    return { output: `Timed out after ${timeoutMs / 1000} seconds. ${quoted} is still ${result.started ? "working" : "not idle"}.\n`, exitCode: 1 };
  }
  const what = result.outcome === "idle" ? "finished and is idle" : result.outcome === "waiting" ? "is waiting for input" : "exited";
  const note = result.started ? "" : `No work was seen starting within ${PANE_SEND_START_GRACE_MS / 1000} seconds: the answer may have come back instantly, or the prompt was ignored.\n`;
  return { output: `${quoted} ${what}.\n${note}`, exitCode: 0 };
}
