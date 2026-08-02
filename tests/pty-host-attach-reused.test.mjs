// attachIfReused contract, end to end through the real socket: a boot-restored
// tab must NOT auto-respawn when the app reconnects to a PTY host that
// predates it (the session either still lives there and is attached, or the
// tab becomes stopped/restartable via no-session) - while a freshly-spawned
// host keeps plain boot auto-start. The resolution lives in
// PtyHostClient.spawn because only the client knows how the host came to be;
// these tests drive two clients against ONE host: the first client spawns the
// host (fresh), the second finds it running (reused).
//
// The PTY host derives its socket path from AYA_HOME at module load time,
// so this test sets AYA_HOME to a fresh tmpdir BEFORE importing the client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-attach-reused-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient, resolveSpawnAttach } = await import(
  "../dist-electron/pty-host-client.js"
);

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

function ptyEventsFor(wc, ptyId) {
  return wc._events
    .filter((e) => e.channel === "pty:event")
    .map((e) => e.payload)
    .filter((p) => p.ptyId === ptyId);
}

const spawnReq = (over) => ({
  ptyId: "id",
  command: "echo hi",
  cwd: TMP_AYA_HOME,
  cols: 80,
  rows: 24,
  ...over,
});

test("resolveSpawnAttach: attach only for an explicit attach or intent+reused", () => {
  // attachOnly (tab already ran this renderer session) always wins.
  assert.equal(resolveSpawnAttach(true, undefined, false), true);
  assert.equal(resolveSpawnAttach(true, true, false), true);
  // attachIfReused needs a REUSED host - forcing attach on a fresh host
  // would wrongly stop every tab at cold boot (the host can hold nothing).
  assert.equal(resolveSpawnAttach(undefined, true, true), true);
  assert.equal(resolveSpawnAttach(undefined, true, false), false);
  // No intent -> plain spawn regardless of host history.
  assert.equal(resolveSpawnAttach(undefined, undefined, true), false);
  assert.equal(resolveSpawnAttach(false, false, true), false);
});

// One host serves all three tests below; the LAST test shuts it down.

test("a client that SPAWNED the host plain-spawns despite attachIfReused (cold boot)", async () => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents(wc);

  // No socket exists yet -> this connect takes the startHost path (fresh).
  await client.spawn(
    spawnReq({ ptyId: "fresh-1", command: "echo fresh-marker", attachIfReused: true }),
  );

  await waitFor(() => ptyEventsFor(wc, "fresh-1").some((e) => e.type === "exit"));
  const events = ptyEventsFor(wc, "fresh-1");
  assert.match(
    events.filter((e) => e.type === "data").map((e) => e.chunk).join(""),
    /fresh-marker/,
    "boot auto-start must still run on a fresh host",
  );
  assert.ok(
    !events.some((e) => e.type === "no-session"),
    "a fresh host must not report no-session for a boot tab",
  );
});

test("a client that FOUND the host running gets no-session for a dead id (no silent respawn)", async () => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents(wc);

  // The previous test's host is still up -> this connect REUSES it.
  await client.spawn(
    spawnReq({ ptyId: "ghost-1", command: "echo should-not-run", attachIfReused: true }),
  );

  await waitFor(() => ptyEventsFor(wc, "ghost-1").some((e) => e.type === "no-session"));
  const events = ptyEventsFor(wc, "ghost-1");
  assert.ok(
    !events.some((e) => e.type === "data" || e.type === "exit"),
    "the dead id must not spawn a process on a reused host",
  );
});

test("attachIfReused still attaches to a LIVE session on a reused host", async (t) => {
  const wcA = fakeWebContents();
  const owner = new PtyHostClient(HOST_SCRIPT);
  owner.attachWebContents(wcA);
  t.after(async () => {
    try {
      await owner.shutdown();
    } catch {
      /* host already gone */
    }
  });

  // Long-lived session under the (reused) host.
  await owner.spawn(spawnReq({ ptyId: "live-1", command: "cat" }));

  const wcB = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.attachWebContents(wcB);
  await client.spawn(spawnReq({ ptyId: "live-1", command: "cat", attachIfReused: true }));

  // The live PTY keeps streaming: a write through the second client comes
  // back (PTY echo). A no-session here would mean attachIfReused killed the
  // attach path; a second process would mean it spawned instead of attaching.
  await client.write("live-1", "ping-round-trip\n");
  await waitFor(() =>
    ptyEventsFor(wcB, "live-1").some(
      (e) => e.type === "data" && e.chunk.includes("ping-round-trip"),
    ),
  );
  assert.ok(
    !ptyEventsFor(wcB, "live-1").some((e) => e.type === "no-session"),
    "a live session must attach, not stop",
  );
  await client.kill("live-1");
});
