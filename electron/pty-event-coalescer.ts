// Coalescing for PTY "data" events on the two hop boundaries they cross
// (pty-host -> main socket line, main -> renderer webContents.send). Every
// hop pays a fixed per-EVENT cost (JSON stringify/parse, syscall, structured
// clone, renderer wakeup), so a busy TUI emitting hundreds of small reads per
// second costs N fixed overheads for the same bytes. Merging consecutive
// chunks of the same stream collapses that to one.
//
// Merging is semantically safe: PTY read boundaries are already arbitrary, so
// consumers must (and do) handle any chunking — a merged chunk is just a
// larger read. Two rules keep ordering intact:
//   - only chunks with the same ptyId AND the same replay flag merge (replay
//     chunks decrement a renderer-side counter per write; collapsing a live
//     chunk into a replay one would mislabel it),
//   - any non-data event flushes pending data first, so e.g. an exit can
//     never overtake the output that preceded it.

import type { PtyEvent } from "./types";

type DataEvent = Extract<PtyEvent, { type: "data" }>;

// Flush pending output early once it grows past this, bounding both memory
// and the size of a single socket line / IPC payload under a firehose.
export const COALESCE_MAX_PENDING_CHARS = 256 * 1024;

export interface PtyDataCoalescer {
  /** Queue (data) or pass through (everything else, after a flush). */
  push(event: PtyEvent): void;
  /** Emit all pending data now. Idempotent. */
  flush(): void;
}

/** Per-tick coalescer for the pty-host: data chunks accumulate per
 *  (ptyId, replay) stream and flush on the next `schedule` callback (the host
 *  passes setImmediate — same event-loop turn, so no added latency a human
 *  could perceive), on a non-data event, or when a stream exceeds the size
 *  cap. `schedule` is injectable for tests. */
export function createPtyDataCoalescer(
  send: (event: PtyEvent) => void,
  schedule: (flush: () => void) => void = (flush) => setImmediate(flush),
  maxPendingChars: number = COALESCE_MAX_PENDING_CHARS,
): PtyDataCoalescer {
  // Insertion order preserves cross-stream arrival order on flush.
  const pending = new Map<string, DataEvent>();
  let flushScheduled = false;

  const flush = (): void => {
    flushScheduled = false;
    if (pending.size === 0) return;
    // Snapshot + clear first: a send() callback that re-enters push (e.g. a
    // test harness, or a sink that writes synchronously) must not observe or
    // re-merge the events being emitted.
    const events = [...pending.values()];
    pending.clear();
    for (const event of events) send(event);
  };

  return {
    push(event: PtyEvent): void {
      if (event.type !== "data") {
        flush();
        send(event);
        return;
      }
      const key = `${event.replay ? "r" : "l"}:${event.ptyId}`;
      const queued = pending.get(key);
      if (queued) {
        queued.chunk += event.chunk;
        if (queued.chunk.length >= maxPendingChars) flush();
        return;
      }
      // Clone: the queued event mutates (chunk grows) and the caller's event
      // object must stay untouched.
      pending.set(key, { ...event });
      if (!flushScheduled) {
        flushScheduled = true;
        schedule(flush);
      }
    },
    flush,
  };
}

/** Merge ADJACENT data events of the same (ptyId, replay) stream in an
 *  already-materialized batch — the main-process client uses this on the
 *  events decoded from one socket read, so a backlog burst crosses the
 *  main->renderer IPC boundary as a few large events instead of hundreds of
 *  small ones. Only neighbors merge, so total order is preserved exactly. */
export function coalesceAdjacentData(events: PtyEvent[]): PtyEvent[] {
  if (events.length < 2) return events;
  const out: PtyEvent[] = [];
  let tail: DataEvent | null = null;
  for (const event of events) {
    if (
      event.type === "data" &&
      tail &&
      tail.ptyId === event.ptyId &&
      !tail.replay === !event.replay
    ) {
      tail.chunk += event.chunk;
      continue;
    }
    if (event.type === "data") {
      tail = { ...event };
      out.push(tail);
    } else {
      tail = null;
      out.push(event);
    }
  }
  return out;
}
