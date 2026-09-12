// Control-socket server: framing, size limit, JSON tolerance, one-shot
// semantics, dispatch. Drives startControlServerOn against a tmp Unix socket.
// parseControlRequest's payload rules live in control-protocol.test.mjs.

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

/** Boot a server on a throwaway socket, run the body, then tear down both. */
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

/** Send one frame (JSON + "\n"), read until close, parse the single reply. */
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

/** Send raw bytes (no JSON framing): the size-limit and malformed paths. */
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

/** Options bag recording every dispatched call. getWindow returns null so the
 *  focus/status paths early-exit without an Electron BrowserWindow. */
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
    // A RELATIVE path: an absolute fixture makes path.resolve the identity
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
    // The MESSAGE is the contract: a catch that stops forwarding err.message
    // would still satisfy a length check.
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
    // Pin the message the PARSER owns, so a crash elsewhere cannot satisfy it.
    assert.match(res.error, /unknown control request type/i);
  });
});

test("control server: the size limit rejects at limit+1 and accepts at the limit", async () => {
  const { options, calls } = recordingOptions();
  await withServer(options, async (socket) => {
    // No "\n", so the per-chunk size check triggers rather than the parser.
    const over = "x".repeat(CONTROL_REQUEST_MAX_SIZE_BYTES + 1);
    assert.match(await rawSend(socket, over), /request too large/);
    assert.deepEqual(calls.openProject, []);

    // Payload PLUS newline exactly at the limit must NOT be rejected: this is
    // the half an off-by-one survives, since it still rejects the huge one.
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
  // limit+1 arrives in one read; a much larger payload is split by the kernel, so
  // without the one-shot guard later chunks write after end (uncaught, main).
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
    assert.deepEqual(
      await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`),
      { ok: true },
    );
  });
});

test("control server: a client that half-closes still gets its reply", async () => {
  // Without allowHalfOpen the FIN ends our writable side and the reply 150 ms
  // later is dropped. Must SUCCEED: a failing send replies at once and passes.
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
  // Two live sinks plus a destroyed one: a single-sink fixture cannot see a
  // regression to "deliver to the first one".
  options.getWindows = () => [sink("a"), sink("gone", true), sink("b")];
  await withServer(options, async (socket) => {
    const before = Date.now();
    const res = await rpc(
      socket,
      // Every field bin/aya sends, so a dropped one has somewhere to show up.
      `${JSON.stringify({
        type: "status",
        level: "active",
        text: "running",
        terminalId: "t1",
        projectSlug: "aya",
        cwd: "/tmp/aya-project",
      })}\n`,
    );
    assert.deepEqual(res, { ok: true });
    // The ack alone proves nothing: the status branch can be deleted and the
    // frame is still acked. The forwarded payload is the contract.
    assert.deepEqual(
      sent.map(([tag]) => tag),
      ["a", "b"],
      "every live sink gets it, the destroyed one gets nothing",
    );
    const [, channel, update] = sent[0];
    assert.equal(channel, "control:status");
    // Whole-object: a per-field spot check leaves the unasserted fields free to
    // be deleted from the update the renderer consumes.
    const { updatedAt, ...rest } = update;
    assert.deepEqual(rest, {
      level: "active",
      text: "running",
      terminalId: "t1",
      projectSlug: "aya",
      cwd: "/tmp/aya-project",
    });
    assert.ok(
      Number.isInteger(updatedAt) && updatedAt >= before && updatedAt <= Date.now(),
      `updatedAt ${updatedAt} must be a timestamp taken during the dispatch`,
    );
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
    // Without this the whole focusWindow body could be a no-op.
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
    // Whole rows: the id column is the handle for pane read/send, and
    // "(this pane)" matching anywhere passes even if every row is marked self.
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
    // Exact, so a TypeError from an undefined listProjects cannot pass for it.
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
    // Two valid frames on one connection; the server closes after the first.
    const frame =
      `${JSON.stringify({ type: "open", path: "/first" })}\n` +
      `${JSON.stringify({ type: "open", path: "/second" })}\n`;
    await rpc(socket, frame);
    assert.deepEqual(calls.openProject, ["/first"]);
  });
});

// "text\r" as ONE chunk reads as a paste burst in the Codex / Claude Code
// composers: the CR becomes a newline in the box and nothing is ever sent.
/** The gap the agent TUIs need, restated independently of the server's constant
 *  so shrinking that constant fails here. Measurements: electron/control.ts. */
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

/** The pane-send frame every test here sends; call sites override the rest. */
const paneSendFrame = (over = {}) =>
  `${JSON.stringify({ type: "pane-send", target: "Codex reviewer", text: "tekst", ...over })}\n`;

test("control server: the shipped submit delay clears what the agent TUIs need", () => {
  // The test below deliberately ignores the constant, so this guards lowering it.
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
    // The floor is the independently-recorded TUI requirement, NOT the SUT's own
    // constant - otherwise shrinking it moves both sides and ships green.
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

// The pty sink drops writes for an id with no live process, and `pane list`
// advertises stale panes, so acking made `aya pane send` exit 0 typing nothing.
test("control server: pane-send fails when the pane has no live process", async () => {
  const { options, writes } = paneOptions({ delivered: false });
  await withServer(options, async (socket) => {
    const res = await rpc(
      socket,
      paneSendFrame({ submit: true }),
    );
    assert.equal(res.ok, false);
    // The message names the OUTCOME, not a cause: the same false comes back when
    // a starting pane's queue took only part of the text.
    assert.match(res.error, /pane "Codex reviewer" did not accept the text/);
    assert.match(res.error, /Nothing was submitted/);
    // And no Enter into the same void.
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
  // Resolves undefined, like a host too old to answer: only an explicit false
  // may become an error.
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

// One pane-send spans two writes with 150 ms of yield between them: without a
// per-terminal lock, two sends interleave into one line plus a stray Enter.
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
    // Whichever won the race, each text is followed by ITS own Enter.
    assert.ok(
      JSON.stringify(data) === JSON.stringify(["alpha", "\r", "beta", "\r"]) ||
        JSON.stringify(data) === JSON.stringify(["beta", "\r", "alpha", "\r"]),
      `interleaved writes: ${JSON.stringify(data)}`,
    );
  });
});

// The queue must survive a failure: a throwing send is chained ahead of what is
// queued behind it, so propagating would swallow another agent's message.
test("control server: a failing pane-send does not cancel the one queued behind it", async () => {
  const { options, writes } = paneOptions();
  // Fail the CR, not the text: failing the first write collapses the send before
  // anything can queue behind it - measured, that left `prior.then(run)` green.
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
    // The survivor ran in full after the doomed one died: text AND its Enter.
    assert.deepEqual(
      writes.map(([, data]) => data),
      ["doomed", "survivor", "\r"],
    );
  });
});

// The read buffer used to keep the dispatched line, so a second data event re-ran
// the SAME request; the submit gap widened that window to 150 ms.
test("control server: a late second chunk does not re-run the request", async () => {
  const { options, writes } = paneOptions();
  await withServer(options, async (socket) => {
    const frame = paneSendFrame({ submit: true });
    await new Promise((resolve, reject) => {
      const c = net.createConnection(socket);
      c.setEncoding("utf8");
      // A socket with no "data" listener stays paused and never sees the FIN,
      // so "close" would never fire and this would hang.
      c.on("data", () => {});
      c.on("error", reject);
      c.on("close", resolve);
      c.on("connect", () => {
        c.write(frame);
        // A COMPLETE second frame: a newline-less byte is absorbed by the buffer
        // reset - measured, deleting the `handled` guard stayed green until this.
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
  // allowHalfOpen keeps our side open past the peer's FIN, so a connection that
  // dies mid-frame is held for the life of the main process unless reaped.
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
  // The "end" reaper only covers a peer that FINs; one that writes a partial
  // frame and then sits there sends none. That is what the idle timeout is for.
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
      // A lingering client handle would turn a FAILURE here into a hung suite.
      client?.destroy();
    }
  });
});

test("control server: the idle reaper never touches a dispatched request", async () => {
  // A pane-send is idle on the wire for the whole submit gap; reaping it would
  // destroy the socket before its reply.
  const { options, writes } = paneOptions();
  // Far below PANE_SEND_SUBMIT_DELAY_MS, so it fires while the handler sleeps.
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
  await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`);
  assert.ok(existsSync(socket), "the socket file should exist while serving");
  stop();
  // Asserting only that a SECOND server can boot proves nothing:
  // startControlServerOn unlinks the path itself on boot.
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
