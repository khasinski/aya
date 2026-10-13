// The pty host holds every terminal of every Aya window. An error nothing catches would end the process and every
// pane with it, and its stderr may lead nowhere; on 2026-10-13 one did, after 26 hours, without a trace. The guard
// writes the error and its stack to the lifecycle log and lets the host serve on: one failed request or socket must
// not cost the user all their sessions.

import type { PtyLogWriter } from "./pty-log";

type GuardedProcess = Pick<NodeJS.Process, "on">;

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

/** Log an uncaught exception or an unhandled rejection with its stack, and keep the process running. */
export function keepHostOnUncaught(log: PtyLogWriter, proc: GuardedProcess = process): void {
  proc.on("uncaughtException", (error: unknown) => {
    log.append("host-uncaught", { kind: "uncaughtException", error: describe(error) });
  });
  proc.on("unhandledRejection", (reason: unknown) => {
    log.append("host-uncaught", { kind: "unhandledRejection", error: describe(reason) });
  });
}
