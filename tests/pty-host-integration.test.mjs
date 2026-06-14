// End-to-end test for the PTY host contract: PtyHostClient launches the host
// as a child process, talks to it over the Unix socket using the
// PtyHostProtocol JSON frames, and forwards PtyEvents through an injected
// "WebContents". Until now nothing exercised this contract; each side has
// internal unit coverage but the socket protocol that they speak to each
// other was untested.
//
// The PTY host derives its socket path from AYA_HOME at module load time,
// so this test sets AYA_HOME to a fresh tmpdir BEFORE importing the client.
// We talk through the client's public API: spawn / write / kill / search /
// shutdown, plus the event sink injected via setWebContents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_AYA_HOME = mkdtempSync(join(tmpdir(), "aya-ptyhost-"));
process.env.AYA_HOME = TMP_AYA_HOME;

const { PtyHostClient } = await import(
  "../dist-electron/pty-host-client.js"
);

const HOST_SCRIPT = join(process.cwd(), "dist-electron", "pty-host.js");

/** Wait until predicate() returns truthy or ms elapses. */
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

test("PtyHostClient: spawn echo then receive data and exit through the event sink", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.setWebContents(wc);
  t.after(async () => {
    try {
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });

  await client.spawn({
    ptyId: "echo-1",
    command: "echo aya-test-marker",
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
  });

  // Wait until we have seen both data chunk(s) and an exit event for this pty.
  await waitFor(() =>
    ptyEventsFor(wc, "echo-1").some((e) => e.type === "exit"),
  );

  const events = ptyEventsFor(wc, "echo-1");
  const data = events.filter((e) => e.type === "data");
  const exit = events.find((e) => e.type === "exit");
  assert.ok(data.length > 0, "expected at least one data event");
  assert.match(
    data.map((e) => e.chunk).join(""),
    /aya-test-marker/,
    "stdout from echo must reach the renderer",
  );
  assert.ok(exit, "expected an exit event");
  assert.equal(exit.exitCode, 0);
});

test("PtyHostClient: spawn into a missing cwd surfaces a spawn-failed event (cwd-missing)", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.setWebContents(wc);
  t.after(async () => {
    try {
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });

  await client.spawn({
    ptyId: "bad-cwd",
    command: "echo nope",
    cwd: "/this/path/really/should/not/exist/aya-test",
    cols: 80,
    rows: 24,
  });

  await waitFor(() =>
    ptyEventsFor(wc, "bad-cwd").some((e) => e.type === "spawn-failed"),
  );
  const failure = ptyEventsFor(wc, "bad-cwd").find(
    (e) => e.type === "spawn-failed",
  );
  assert.equal(failure.reason, "cwd-missing");
  assert.equal(typeof failure.detail, "string");
});

test("PtyHostClient: write reaches the PTY and is echoed back via the data event", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.setWebContents(wc);
  t.after(async () => {
    try {
      await client.kill("cat-1");
    } catch {
      /* terminal may already be dead */
    }
    try {
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });

  // `cat` echoes its stdin until EOF; perfect for testing write().
  await client.spawn({
    ptyId: "cat-1",
    command: "cat",
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
  });

  // The wrapper shell prints its own prompt/leader before exec; wait until
  // we know the PTY has booted by sending input and watching for it back.
  await client.write("cat-1", "round-trip-token\n");
  await waitFor(() =>
    ptyEventsFor(wc, "cat-1")
      .filter((e) => e.type === "data")
      .map((e) => e.chunk)
      .join("")
      .includes("round-trip-token"),
  );
});

test("PtyHostClient: search returns hits across living PTYs", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.setWebContents(wc);
  t.after(async () => {
    try {
      await client.kill("cat-search");
    } catch {
      /* nothing to do */
    }
    try {
      await client.shutdown();
    } catch {
      /* host already gone */
    }
  });

  await client.spawn({
    ptyId: "cat-search",
    command: "cat",
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
  });

  await client.write("cat-search", "needle-in-the-stack\n");
  await waitFor(() =>
    ptyEventsFor(wc, "cat-search")
      .filter((e) => e.type === "data")
      .map((e) => e.chunk)
      .join("")
      .includes("needle-in-the-stack"),
  );

  const hits = await client.search("needle-in-the-stack");
  assert.ok(Array.isArray(hits), "search returns an array");
  assert.ok(
    hits.some((h) => h.ptyId === "cat-search"),
    "the search hit must reference the live pty id",
  );
});

test("PtyHostClient: shutdown drops the socket file (clean restart possible)", async (t) => {
  const wc = fakeWebContents();
  const client = new PtyHostClient(HOST_SCRIPT);
  client.setWebContents(wc);

  await client.spawn({
    ptyId: "ephemeral",
    command: "echo done",
    cwd: TMP_AYA_HOME,
    cols: 80,
    rows: 24,
  });
  await waitFor(() =>
    ptyEventsFor(wc, "ephemeral").some((e) => e.type === "exit"),
  );

  const socketPath = join(TMP_AYA_HOME, "pty-host.sock");
  // Host is alive → socket should exist.
  assert.ok(existsSync(socketPath));

  await client.shutdown();

  // After shutdown the host closes the socket BEFORE exiting; allow a few
  // ticks for filesystem propagation, then assert it's gone.
  await waitFor(() => !existsSync(socketPath), 2000);
  assert.equal(existsSync(socketPath), false);
});

test.after(() => {
  try {
    rmSync(TMP_AYA_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
