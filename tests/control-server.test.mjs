// Tests for the control-socket server: framing, size limit, JSON tolerance,
// per-connection one-shot semantics, and dispatch into the injected options.
// Drives startControlServerOn against a tmp Unix socket so it doesn't need
// Electron at all. parseControlRequest's payload-level rules are covered
// separately in control-protocol.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  startControlServerOn,
  CONTROL_REQUEST_MAX_SIZE_BYTES,
  PANE_SEND_SUBMIT_DELAY_MS,
} = await import("../dist-electron/control.js");

function mkSocketPath() {
  const dir = mkdtempSync(join(tmpdir(), "aya-ctrl-"));
  return { dir, socket: join(dir, "aya.sock") };
}

/** Boot a server on a throwaway socket, run the body against it, then always
 *  tear the server AND its tmp dir down. Every test here needs that same
 *  three-line prologue and four-line epilogue; only the body differs. */
async function withServer(options, body) {
  const { dir, socket } = mkSocketPath();
  const stop = startControlServerOn(socket, options);
  try {
    return await body(socket);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Send one frame (JSON + "\n") over a unix socket, read until close, parse
 *  the single JSON response the server is expected to write. */
function rpc(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk) => {
      buf += chunk;
    });
    c.on("close", () => {
      const line = buf.split("\n")[0];
      if (!line) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    });
    c.on("error", reject);
    c.on("connect", () => c.write(frame));
  });
}

/** Send raw bytes (no JSON framing) — used to drive the size-limit and
 *  malformed-JSON paths. */
function rawSend(socketPath, bytes) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk) => {
      buf += chunk;
    });
    c.on("close", () => resolve(buf));
    c.on("error", reject);
    c.on("connect", () => c.write(bytes));
  });
}

/** Build an options bag that records every dispatched call so tests can
 *  assert on it. getWindow returns null by default so the focus/status paths
 *  early-exit without trying to use the Electron BrowserWindow. */
function recordingOptions() {
  const calls = { openProject: [] };
  return {
    calls,
    options: {
      getWindow: () => null,
      openProject: (dir) => calls.openProject.push(dir),
    },
  };
}

test("control server: open dispatches the resolved path and acknowledges", async () => {
  const { options, calls } = recordingOptions();
  await withServer(options, async (socket) => {
    // A RELATIVE path, because "resolved" is the contract: `aya open .` is the
    // common invocation. An absolute fixture makes path.resolve the identity
    // function, so its removal would go unnoticed.
    const res = await rpc(
      socket,
      `${JSON.stringify({ type: "open", path: "sub/dir" })}\n`,
    );
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(calls.openProject, [join(process.cwd(), "sub/dir")]);
  });
});

test("control server: malformed JSON returns ok:false with the parser error", async () => {
  const { options } = recordingOptions();
  await withServer(options, async (socket) => {
    const res = await rpc(socket, "{ not json\n");
    assert.equal(res.ok, false);
    // The MESSAGE is the contract, not merely "some non-empty string": a catch
    // that stops forwarding err.message would still satisfy a length check.
    assert.match(res.error, /JSON|Unexpected token/i);
  });
});

test("control server: an unknown request type is rejected by the protocol parser", async () => {
  const { options } = recordingOptions();
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      `${JSON.stringify({ type: "spaceship" })}\n`,
    );
    assert.equal(res.ok, false);
    // Pin the message the PARSER owns, so this cannot be satisfied by a crash
    // somewhere else in the socket handler.
    assert.match(res.error, /unknown control request type/i);
  });
});

test("control server: the size limit rejects at limit+1 and accepts at the limit", async () => {
  const { options, calls } = recordingOptions();
  await withServer(options, async (socket) => {
    // Just over: rejected. Sent without a "\n" so the per-chunk size check is
    // what triggers, not the parser.
    const over = "x".repeat(CONTROL_REQUEST_MAX_SIZE_BYTES + 1);
    assert.match(await rawSend(socket, over), /request too large/);
    assert.deepEqual(calls.openProject, []);

    // A frame whose whole buffered size - payload PLUS the framing newline -
    // is exactly the limit must NOT be rejected. This is the half that a
    // far-over-the-limit payload can never pin: an off-by-one in the
    // comparison still rejects the huge one.
    const empty = JSON.stringify({ type: "open", path: "/tmp/x", pad: "" });
    const atLimit = JSON.stringify({
      type: "open",
      path: "/tmp/x",
      // -1 for the "\n" the server counts as part of the buffer.
      pad: "y".repeat(CONTROL_REQUEST_MAX_SIZE_BYTES - 1 - empty.length),
    });
    assert.equal(atLimit.length + 1, CONTROL_REQUEST_MAX_SIZE_BYTES);
    const res = await rpc(socket, `${atLimit}\n`);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(calls.openProject, ["/tmp/x"]);
  });
});

test("control server: a MUCH-too-large frame is rejected once and does not crash", async () => {
  // The limit+1 case above arrives in a single read, so it only ever enters the
  // over-size branch once. A payload several times the limit is split by the
  // kernel: without the one-shot guard on that branch, every later chunk
  // re-enters it and writes onto the socket we already ended -
  // ERR_STREAM_WRITE_AFTER_END, uncaught, in the Electron main process.
  // `aya pane send <pane> "<~70 KB>"` reaches this from the shipped CLI.
  const { options } = recordingOptions();
  await withServer(options, async (socket) => {
    const response = await rawSend(
      socket,
      "x".repeat(CONTROL_REQUEST_MAX_SIZE_BYTES * 5),
    );
    // Exactly one rejection, not one per chunk.
    assert.deepEqual(
      response.split("\n").filter(Boolean).map((l) => JSON.parse(l)),
      [{ ok: false, error: "request too large" }],
    );
    // The server is still alive and still answering afterwards.
    assert.deepEqual(
      await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`),
      { ok: true },
    );
  });
});

test("control server: a client that half-closes still gets its reply", async () => {
  // `socket.end(frame)` is the textbook request/response shape. pane-send holds
  // the connection open across the submit gap, so without allowHalfOpen the
  // incoming FIN ends our writable side and the reply 150 ms later is dropped -
  // turning the new "fail loudly" contract back into a silent success.
  // A SUCCEEDING submit, so the reply really is written one full
  // PANE_SEND_SUBMIT_DELAY_MS after the client's FIN. A failing send answers
  // immediately and would sail through even without allowHalfOpen.
  const { options } = paneOptions();
  await withServer(options, async (socket) => {
    const reply = await new Promise((resolve, reject) => {
      const c = net.createConnection(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (chunk) => {
        buf += chunk;
      });
      c.on("close", () => resolve(buf));
      c.on("error", reject);
      c.on("connect", () => c.end(paneSendFrame({ submit: true })));
    });
    assert.ok(reply.trim(), "a half-closing client received no reply at all");
    assert.equal(JSON.parse(reply.split("\n")[0]).ok, true);
  });
});

test("control server: status is forwarded to every window sink", async () => {
  const { options } = recordingOptions();
  const sent = [];
  const sink = (tag, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { send: (channel, update) => sent.push([tag, channel, update]) },
  });
  // TWO live sinks plus a destroyed one. In production getWindows returns every
  // window plus the Aya Web virtual sink, so a single-sink fixture cannot see a
  // regression to "deliver to the first one" - which would silently strip
  // status dots from every other window and from the browser client.
  options.getWindows = () => [sink("a"), sink("gone", true), sink("b")];
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      `${JSON.stringify({
        type: "status",
        level: "active",
        text: "running",
        terminalId: "t1",
      })}\n`,
    );
    assert.deepEqual(res, { ok: true });
    // The ack alone proves nothing: the whole status branch can be deleted and
    // the frame is still acked. The forwarded payload is the contract.
    assert.deepEqual(
      sent.map(([tag]) => tag),
      ["a", "b"],
      "every live sink gets it, the destroyed one gets nothing",
    );
    const [, channel, update] = sent[0];
    assert.equal(channel, "control:status");
    assert.equal(update.level, "active");
    assert.equal(update.text, "running");
    assert.equal(update.terminalId, "t1");
  });
});

test("control server: status dispatches without a window are a clean no-op", async () => {
  const { options } = recordingOptions(); // getWindow returns null
  const sent = [];
  options.getWindows = () => {
    sent.push("asked");
    return [];
  };
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      `${JSON.stringify({
        type: "status",
        level: "active",
        text: "running",
      })}\n`,
    );
    assert.deepEqual(res, { ok: true });
    // Nothing to deliver to, and nothing thrown on the way there.
    assert.deepEqual(sent, ["asked"]);
  });
});

test("control server: focus restores and focuses the window", async () => {
  const { options } = recordingOptions();
  const acts = [];
  options.getWindow = () => ({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => acts.push("restore"),
    focus: () => acts.push("focus"),
  });
  await withServer(options, async (socket) => {
    const res = await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`);
    assert.deepEqual(res, { ok: true });
    // Without this the whole focusWindow body could be a no-op: every other
    // focus test asserts only the generic envelope.
    assert.deepEqual(acts, ["restore", "focus"]);
  });
});

test("control server: focus without a window does NOT throw and still acks", async () => {
  const { options } = recordingOptions();
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      `${JSON.stringify({ type: "focus" })}\n`,
    );
    assert.deepEqual(res, { ok: true });
  });
});

test("control server: pane-list returns a formatted listing scoped to the project", async () => {
  const { options } = recordingOptions();
  options.listProjects = async () => [
    {
      slug: "demo",
      name: "demo",
      directory: "/demo",
      tabs: [
        { id: "t1", presetId: "codex", name: "builder" },
        { id: "t2", presetId: "claude", name: "reviewer" },
      ],
    },
    {
      slug: "other",
      name: "other",
      directory: "/other",
      tabs: [{ id: "t9", presetId: "shell", name: "scratch" }],
    },
  ];
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      `${JSON.stringify({
        type: "pane-list",
        projectSlug: "demo",
        selfTerminalId: "t1",
      })}\n`,
    );
    assert.equal(res.ok, true);
    // Whole rows, not loose substrings: the preset and terminal-id columns are
    // the handles an agent passes back to pane read/send, and "(this pane)"
    // matching ANYWHERE would still pass if every row were marked as self.
    assert.deepEqual(res.output.split("\n").filter(Boolean), [
      "* builder   codex   t1  (this pane)",
      "  reviewer  claude  t2",
    ]);
    // The unrelated project's pane is absent (project scoping).
    assert.doesNotMatch(res.output, /scratch/);
  });
});

test("control server: pane-list without listProjects reports it is unavailable", async () => {
  const { options } = recordingOptions(); // no listProjects
  await withServer(options, async (socket) => {
    const res = await rpc(socket, `${JSON.stringify({ type: "pane-list" })}\n`);
    assert.equal(res.ok, false);
    // Exact, so a TypeError from calling an undefined listProjects cannot pass
    // for the guard firing.
    assert.equal(res.error, "pane control is not available");
  });
});

test("control server: data delivered in two chunks across the newline is parsed", async () => {
  const { options, calls } = recordingOptions();
  await withServer(options, async (socket) => {
    const result = await new Promise((resolve, reject) => {
      const c = net.createConnection(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (chunk) => (buf += chunk));
      c.on("close", () => resolve(buf));
      c.on("error", reject);
      c.on("connect", () => {
        const payload = JSON.stringify({ type: "open", path: "/x" });
        c.write(payload.slice(0, 8));
        setTimeout(() => c.write(`${payload.slice(8)}\n`), 10);
      });
    });
    assert.match(result, /"ok":true/);
    assert.deepEqual(calls.openProject, ["/x"]);
  });
});

test("control server: only the first line of a frame is parsed (one-shot per connection)", async () => {
  const { options, calls } = recordingOptions();
  await withServer(options, async (socket) => {
    // Two valid frames on one connection. The server closes after the first,
    // so only the first dispatch happens.
    const frame =
      `${JSON.stringify({ type: "open", path: "/first" })}\n` +
      `${JSON.stringify({ type: "open", path: "/second" })}\n`;
    await rpc(socket, frame);
    assert.deepEqual(calls.openProject, ["/first"]);
  });
});

// pane-send must submit for real. Writing "text\r" as ONE chunk is read as a
// paste burst by the Codex / Claude Code composers, which turns the carriage
// return into a newline in the message box - the text appears but is never
// sent. The CR therefore has to be its own write, after the burst goes idle.
/** The gap the AGENT TUIs need, restated independently of the constant the
 *  server uses so that shrinking that constant fails here instead of moving
 *  both sides at once. Measurements: electron/control.ts. */
const REQUIRED_SUBMIT_GAP_MS = 120;

function paneOptions({ delivered = true } = {}) {
  const writes = [];
  return {
    writes,
    options: {
      getWindow: () => null,
      openProject: () => {},
      listProjects: async () => [
        { slug: "aya", tabs: [{ id: "term-7", name: "Codex reviewer" }] },
      ],
      readPane: async () => "",
      writePane: async (terminalId, data) => {
        writes.push([terminalId, data, Date.now()]);
        return delivered;
      },
    },
  };
}

/** The pane-send frame every test here sends, with only the bits that differ
 *  spelled out at the call site. */
const paneSendFrame = (over = {}) =>
  `${JSON.stringify({ type: "pane-send", target: "Codex reviewer", text: "tekst", ...over })}\n`;

test("control server: the shipped submit delay clears what the agent TUIs need", () => {
  // A separate guard, because the test below deliberately does not read the
  // constant: something still has to fail when someone lowers it.
  assert.ok(
    PANE_SEND_SUBMIT_DELAY_MS >= REQUIRED_SUBMIT_GAP_MS,
    `PANE_SEND_SUBMIT_DELAY_MS is ${PANE_SEND_SUBMIT_DELAY_MS}ms; Claude Code's composer needed ${REQUIRED_SUBMIT_GAP_MS}ms to read the CR as Enter`,
  );
});

test("control server: pane-send --submit sends the CR as a separate, later write", async () => {
  const { options, writes } = paneOptions();
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      paneSendFrame({ submit: true }),
    );
    assert.equal(res.ok, true);
    assert.deepEqual(
      writes.map(([id, data]) => [id, data]),
      [
        ["term-7", "tekst"],
        ["term-7", "\r"],
      ],
    );
    // The gap is the whole point: a CR in the same burst is not an Enter.
    // The floor is the independently-recorded TUI requirement, NOT the SUT's
    // own constant - otherwise shrinking the constant moves both sides and the
    // regression ships green.
    const gap = writes[1][2] - writes[0][2];
    assert.ok(
      gap >= REQUIRED_SUBMIT_GAP_MS,
      `CR followed after ${gap}ms, expected >= ${REQUIRED_SUBMIT_GAP_MS}`,
    );
  });
});

test("control server: pane-send without --submit types only, no CR", async () => {
  const { options, writes } = paneOptions();
  await withServer(options, async (socket) => {
    await rpc(
      socket,
      paneSendFrame(),
    );
    assert.deepEqual(
      writes.map(([id, data]) => [id, data]),
      [["term-7", "tekst"]],
    );
  });
});

// A pane-send that types into nothing must SAY so. The pty sink drops writes
// for any id with no live process, and pane targets are resolved from the
// on-disk project config - which `pane list` also enumerates - so a stale pane
// name is easy to reach. Acking it as success made `aya pane send` exit 0
// having typed nothing.
test("control server: pane-send fails when the pane has no live process", async () => {
  const { options, writes } = paneOptions({ delivered: false });
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      paneSendFrame({ submit: true }),
    );
    assert.equal(res.ok, false);
    // The message names the OUTCOME, not a guessed cause: the same false also
    // comes back when a starting pane's input queue could only take part of the
    // text, and "no running process" would be wrong there.
    assert.match(res.error, /pane "Codex reviewer" did not accept the text/);
    assert.match(res.error, /Nothing was submitted/);
    // And it must not go on to send an Enter into the same void.
    assert.deepEqual(
      writes.map(([, data]) => data),
      ["tekst"],
    );
  });
});

test("control server: a pane that dies during the submit gap is reported", async () => {
  const { options, writes } = paneOptions();
  // Alive for the text, gone by the time the Enter is delivered.
  options.writePane = async (terminalId, data) => {
    writes.push([terminalId, data, Date.now()]);
    return data !== "\r";
  };
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      paneSendFrame({ submit: true }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /exited before the text was submitted/);
  });
});

test("control server: a writePane that cannot report delivery still succeeds", async () => {
  const { options, writes } = paneOptions();
  // Resolves undefined, like a host too old to answer the question. Only an
  // explicit false may be turned into an error - an unknown answer must not.
  options.writePane = async (terminalId, data) => {
    writes.push([terminalId, data, Date.now()]);
  };
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      paneSendFrame(),
    );
    assert.equal(res.ok, true);
    assert.deepEqual(
      writes.map(([, data]) => data),
      ["tekst"],
    );
  });
});

// The submit gap makes one pane-send span two writes with 150 ms of yield in
// between. Without a per-terminal lock two concurrent sends interleave into a
// single merged line plus a stray Enter - and `pane list` exists precisely so
// several agents can drive each other's panes.
test("control server: concurrent pane-sends to one pane do not interleave", async () => {
  const { options, writes } = paneOptions();
  await withServer(options, async (socket) => {
    const send = (text) =>
      rpc(
        socket,
        paneSendFrame({ text, submit: true }),
      );
    const [a, b] = await Promise.all([send("alpha"), send("beta")]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const data = writes.map(([, d]) => d);
    // Whichever won the race, each text is immediately followed by ITS Enter.
    assert.ok(
      JSON.stringify(data) === JSON.stringify(["alpha", "\r", "beta", "\r"]) ||
        JSON.stringify(data) === JSON.stringify(["beta", "\r", "alpha", "\r"]),
      `interleaved writes: ${JSON.stringify(data)}`,
    );
  });
});

// The other half of the per-pane lock: the queue must survive a failure. A
// send that throws (a dead pane, mid-sequence) is chained ahead of whatever is
// already queued behind it, so if the failure propagated down the chain it
// would cancel sends that have nothing to do with it - one agent's dead pane
// would silently swallow another agent's message.
test("control server: a failing pane-send does not cancel the one queued behind it", async () => {
  const { options, writes } = paneOptions();
  // Fail the CR, not the text: the doomed send then holds the lock for the
  // whole submit gap, which is what gives the second send time to QUEUE behind
  // it. Failing the first write instead makes the sequence collapse before the
  // second request even arrives - measured: that version left a chain-breaking
  // `prior.then(run)` green, because nothing was ever queued.
  const realWritePane = options.writePane;
  let writeCount = 0;
  options.writePane = async (terminalId, data) => {
    writeCount += 1;
    if (writeCount === 2) throw new Error("pane exploded mid-sequence");
    return realWritePane(terminalId, data);
  };
  await withServer(options, async (socket) => {
    const send = (text) =>
      rpc(
        socket,
        paneSendFrame({ text, submit: true }),
      );
    const results = await Promise.all([send("doomed"), send("survivor")]);
    const failed = results.filter((r) => !r.ok);
    const succeeded = results.filter((r) => r.ok);
    assert.equal(failed.length, 1, `expected exactly one failure: ${JSON.stringify(results)}`);
    assert.equal(succeeded.length, 1, `expected one send to survive: ${JSON.stringify(results)}`);
    // And the survivor really ran, in full, after the doomed one died: its
    // text AND its own Enter reached the pane.
    assert.deepEqual(
      writes.map(([, data]) => data),
      ["doomed", "survivor", "\r"],
    );
  });
});

// The read buffer used to keep the dispatched line, so a second data event
// re-ran the SAME request. pane-send now holds the connection open across the
// submit gap, which widened that window from a microtask to 150 ms.
test("control server: a late second chunk does not re-run the request", async () => {
  const { options, writes } = paneOptions();
  await withServer(options, async (socket) => {
    const frame = paneSendFrame({ submit: true });
    await new Promise((resolve, reject) => {
      const c = net.createConnection(socket);
      c.setEncoding("utf8");
      // A socket with no "data" listener stays paused and never observes the
      // server's FIN, so "close" would never fire and this would hang.
      c.on("data", () => {});
      c.on("error", reject);
      c.on("close", resolve);
      c.on("connect", () => {
        c.write(frame);
        // A COMPLETE second frame, not a stray byte. A byte with no newline is
        // absorbed by the buffer reset alone, so it cannot tell whether the
        // one-shot `handled` guard exists - measured: deleting that guard left
        // this test green until the stimulus became a real frame, at which
        // point the pane gets typed into and Entered twice on one connection.
        setTimeout(() => c.write(frame), 40);
      });
    });
    assert.deepEqual(
      writes.map(([, data]) => data),
      ["tekst", "\r"],
    );
  });
});

test("control server: a half-close WITHOUT a complete frame is not retained", async () => {
  // allowHalfOpen stops Node ending our side on the peer's FIN, which is what
  // lets a delayed reply through - but it also means a connection that dies
  // mid-frame would be kept for the life of the main process unless we reap it.
  const { options } = recordingOptions();
  await withServer(options, async (socket) => {
    const closed = await new Promise((resolve, reject) => {
      const c = net.createConnection(socket);
      c.setEncoding("utf8");
      c.on("data", () => {});
      c.on("error", reject);
      // Our side is destroyed by the server, which closes the client too.
      c.on("close", () => resolve(true));
      // A truncated frame: no newline will ever arrive.
      c.on("connect", () => c.end('{"type":"foc'));
      setTimeout(() => resolve(false), 2_000);
    });
    assert.equal(closed, true, "the server kept a half-open, frameless socket");
  });
});

test("control server: a silent connection is reaped after the idle window", async () => {
  // The other reaper (socket "end") only covers a peer that FINs. A peer that
  // connects, writes a partial frame and then just sits there sends no FIN at
  // all - that is what the idle timeout is for, and nothing covered it.
  const { options } = recordingOptions();
  options.idleTimeoutMs = 150;
  await withServer(options, async (socket) => {
    let client;
    try {
      const closed = await new Promise((resolve, reject) => {
        const c = net.createConnection(socket);
        client = c;
        c.setEncoding("utf8");
        c.on("data", () => {});
        c.on("error", reject);
        c.on("close", () => resolve(true));
        // No newline, and deliberately no end() - the connection just goes quiet.
        c.on("connect", () => c.write('{"type":"foc'));
        setTimeout(() => resolve(false), 3_000);
      });
      assert.equal(closed, true, "a silent half-written connection was retained");
    } finally {
      // Without a reaper the server keeps its side open, and a lingering client
      // handle would turn this test's FAILURE into a hung suite - a stalled CI
      // job instead of a red one.
      client?.destroy();
    }
  });
});

test("control server: the idle reaper never touches a dispatched request", async () => {
  // The direction that matters more: a pane-send is idle on the wire for the
  // whole submit gap. Reaping it would destroy the socket before its reply.
  const { options, writes } = paneOptions();
  // Far shorter than PANE_SEND_SUBMIT_DELAY_MS, so the timeout definitely fires
  // while the handler is sleeping.
  options.idleTimeoutMs = 40;
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      paneSendFrame({ submit: true }),
    );
    assert.deepEqual(res, {
      ok: true,
      terminalId: "term-7",
      projectSlug: "aya",
      name: "Codex reviewer",
    });
    assert.deepEqual(
      writes.map(([, data]) => data),
      ["tekst", "\r"],
    );
  });
});

test("control server: stop() removes the socket file so reboot is clean", async () => {
  const { dir, socket } = mkSocketPath();
  const { options } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  // Give listen() a tick to chmod the socket file.
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Use rpc once so we know the socket exists/works.
  await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`);
  assert.ok(existsSync(socket), "the socket file should exist while serving");
  stop();
  // The filesystem IS the contract here. Asserting only that a SECOND server
  // can boot proves nothing: startControlServerOn unlinks the path itself on
  // boot, so that succeeds even when stop() removes nothing.
  assert.equal(
    existsSync(socket),
    false,
    "stop() must remove the socket file it created",
  );
  // And the old server must really be gone, not merely unlinked.
  await assert.rejects(() => rpc(socket, `${JSON.stringify({ type: "focus" })}\n`));
  const second = startControlServerOn(socket, options);
  try {
    const res = await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`);
    assert.deepEqual(res, { ok: true });
  } finally {
    second();
    rmSync(dir, { recursive: true, force: true });
  }
});
