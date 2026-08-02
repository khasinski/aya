// Durable PTY lifecycle log: one JSON object per line, appended to
// ~/.aya/pty-events.log by whichever process runs the PTY layer (normally the
// detached pty host). It exists to answer, after the fact, questions the
// in-memory Attention Center feed cannot (it dies with the renderer):
// "what killed all my consoles at 03:12?" - a burst of exit/kill lines, a
// host-shutdown-begin with its reason, or a fresh host-start tells the story.
//
// Design constraints:
// - Logging must NEVER break the PTY layer: every append is wrapped, all
//   THROWN failures are swallowed. (A blocked sync write - hung NFS $HOME,
//   a FIFO planted at the log path - is not a throw and would stall the
//   host; accepted risk, see #95.)
// - Small and self-limiting: the file rotates to a single `.1` generation at
//   PTY_LOG_MAX_BYTES, so it cannot grow unbounded on a chatty session.
// - Every line carries ts (ISO), pid (writer - distinguishes overlapping
//   hosts during a handoff), and ev (event name); event-specific fields
//   follow. Sizes are measured in BYTES (Buffer.byteLength), not string
//   length - commands can contain multibyte characters.

import * as fs from "node:fs";
import * as path from "node:path";
import { AYA_HOME } from "./paths";

export const PTY_LOG_FILE = path.join(AYA_HOME, "pty-events.log");
export const PTY_LOG_MAX_BYTES = 1_000_000;

export interface PtyLogWriter {
  append(event: string, fields?: Record<string, unknown>): void;
}

/** Create a lifecycle-log writer. Exported (with an injectable path and cap)
 *  so tests can exercise append/rotation against a temp file; production code
 *  uses the `ptyLog` singleton below. */
export function createPtyLog(
  file: string = PTY_LOG_FILE,
  maxBytes: number = PTY_LOG_MAX_BYTES,
): PtyLogWriter {
  // Lazily stat'ed on first append, then tracked in-process. A concurrent
  // writer (second host during a handoff) can make the size drift; the only
  // consequence is rotating slightly early or late, which is fine.
  let size = -1;
  return {
    append(event, fields) {
      try {
        const line = `${JSON.stringify({
          ts: new Date().toISOString(),
          pid: process.pid,
          ev: event,
          ...fields,
        })}\n`;
        const bytes = Buffer.byteLength(line);
        if (size < 0 || size + bytes > maxBytes) {
          // Re-stat instead of trusting the in-process counter before acting
          // on it: a concurrent writer (second host during a handoff) may
          // have rotated already, and rotating again off a stale size would
          // rename a near-empty file OVER the freshly rotated generation and
          // destroy it (#89).
          try {
            size = fs.statSync(file).size;
          } catch {
            size = 0;
          }
        }
        if (size + bytes > maxBytes) {
          // No inner try: if the rename fails (`.1` unwritable), the outer
          // catch drops this line while `size` keeps the real file size - the
          // cap must hold even when rotation is impossible, and the previous
          // unconditional `size = 0` here let the file grow without bound
          // (#89). A single line larger than the whole cap is dropped the
          // same way (spawn already clamps its command field).
          fs.renameSync(file, `${file}.1`);
          size = 0;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line);
        size += bytes;
      } catch {
        // Logging must never break the PTY layer.
      }
    },
  };
}

/** Singleton used by the PTY layer. The file path is resolved lazily at the
 *  FIRST append and honors a process.env.AYA_HOME set after module load -
 *  unit tests import the compiled pty module statically (so paths.ts already
 *  snapshotted the real home) and only then point AYA_HOME at a tmpdir; eager
 *  resolution here would make those tests write into the user's real ~/.aya. */
let lazyLog: PtyLogWriter | null = null;
export const ptyLog: PtyLogWriter = {
  append(event, fields) {
    if (!lazyLog) {
      const env = process.env.AYA_HOME?.trim();
      lazyLog = createPtyLog(
        env ? path.join(path.resolve(env), "pty-events.log") : PTY_LOG_FILE,
      );
    }
    lazyLog.append(event, fields);
  },
};
