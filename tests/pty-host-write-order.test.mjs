// Socket-write FIFO across the cold-start connect. Regression pin: spawn()
// once awaited connect() ITSELF before request() (to read reusedHost for the
// attachIfReused resolution), giving spawn's socket write TWO connect awaits
// while write() had ONE. Requests queued while the cold-start connect was in
// flight then flushed with the write AHEAD of the spawn line; the host found
// no PTY for the write and silently dropped it - the renderer's first typed
// bytes vanished (dead keyboard on freshly-booted tabs; caught by e2e as
// terminals that render output but ignore input).
//
// The command's env-assignment prefix keeps the host preflight synchronous
// ($-free binaries would await a command-exists probe), so with correct FIFO
// the early write lands after the PTY registers and echoes back.
//
// Own AYA_HOME (socket namespace): this test must own the cold start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-write-order-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import("../dist-electron/pty-host-client.js");

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");

async function waitFor(predicate, ms = 4000, step = 25) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

function fakeWebContents() {
  const events = [];
  return {
    isDestroyed: () => false,
    send: (channel, payload) => events.push({ channel, payload }),
    _events: events,
  };
}

test("a write queued during the cold-start connect lands AFTER the spawn", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents(wc);
  t.after(async () => {
    try {
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });

  // No socket exists yet - BOTH calls queue on the same cold-start connect.
  const spawned = client.spawn({
    ptyId: "fifo-1",
    command: "AYA_E2E_FIFO=1 cat",
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
    attachIfReused: true,
  });
  const wrote = client.write("fifo-1", "fifo-ping\n");
  await Promise.all([spawned, wrote]);

  const echoed = await waitFor(() =>
    ptyEventsFor().some((e) => e.type === "data" && e.chunk.includes("fifo-ping")),
  ).catch(() => false);
  assert.ok(
    echoed,
    "the early write must reach the PTY - a dropped write means spawn's socket line lost FIFO",
  );

  function ptyEventsFor() {
    return wc._events
      .filter((e) => e.channel === "pty:event")
      .map((e) => e.payload)
      .filter((p) => p.ptyId === "fifo-1");
  }
});
