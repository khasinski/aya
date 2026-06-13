// Tests for the control-socket server: framing, size limit, JSON tolerance,
// per-connection one-shot semantics, and dispatch into the injected options.
// Drives startControlServerOn against a tmp Unix socket so it doesn't need
// Electron at all. parseControlRequest's payload-level rules are covered
// separately in control-protocol.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  startControlServerOn,
  CONTROL_REQUEST_MAX_SIZE_BYTES,
} = await import("../dist-electron/control.js");

function mkSocketPath() {
  const dir = mkdtempSync(join(tmpdir(), "aya-ctrl-"));
  return { dir, socket: join(dir, "aya.sock") };
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
  const { dir, socket } = mkSocketPath();
  const { options, calls } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
    const res = await rpc(
      socket,
      `${JSON.stringify({ type: "open", path: "/tmp/somewhere" })}\n`,
    );
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(calls.openProject, ["/tmp/somewhere"]);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: malformed JSON returns ok:false with the parser error", async () => {
  const { dir, socket } = mkSocketPath();
  const { options } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
    const res = await rpc(socket, "{ not json\n");
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, "string");
    assert.ok(res.error.length > 0);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: an unknown request type is rejected by the protocol parser", async () => {
  const { dir, socket } = mkSocketPath();
  const { options, calls } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
    const res = await rpc(
      socket,
      `${JSON.stringify({ type: "spaceship" })}\n`,
    );
    assert.equal(res.ok, false);
    // And the dispatch must NOT have been called for an unknown type.
    assert.deepEqual(calls.openProject, []);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: a frame above the 64 KB limit is rejected before parsing", async () => {
  const { dir, socket } = mkSocketPath();
  const { options, calls } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
    // Send a payload that exceeds the size limit even though it is otherwise
    // valid JSON. We never emit a "\n" so the server's per-chunk size check
    // is what triggers the rejection.
    const huge = "x".repeat(CONTROL_REQUEST_MAX_SIZE_BYTES + 100);
    const response = await rawSend(socket, huge);
    assert.match(response, /request too large/);
    assert.deepEqual(calls.openProject, []);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: status dispatches without a window are a clean no-op", async () => {
  const { dir, socket } = mkSocketPath();
  const { options } = recordingOptions(); // getWindow returns null
  const stop = startControlServerOn(socket, options);
  try {
    // status currently requires a window to forward into; with no window the
    // handler should still send back ok:true and close the connection.
    const res = await rpc(
      socket,
      `${JSON.stringify({
        type: "status",
        level: "active",
        text: "running",
      })}\n`,
    );
    assert.deepEqual(res, { ok: true });
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: focus without a window does NOT throw and still acks", async () => {
  const { dir, socket } = mkSocketPath();
  const { options } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
    const res = await rpc(
      socket,
      `${JSON.stringify({ type: "focus" })}\n`,
    );
    assert.deepEqual(res, { ok: true });
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: data delivered in two chunks across the newline is parsed", async () => {
  const { dir, socket } = mkSocketPath();
  const { options, calls } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
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
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: only the first line of a frame is parsed (one-shot per connection)", async () => {
  const { dir, socket } = mkSocketPath();
  const { options, calls } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  try {
    // Two valid frames on one connection. The server closes after the first,
    // so only the first dispatch happens.
    const frame =
      `${JSON.stringify({ type: "open", path: "/first" })}\n` +
      `${JSON.stringify({ type: "open", path: "/second" })}\n`;
    await rpc(socket, frame);
    assert.deepEqual(calls.openProject, ["/first"]);
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server: stop() removes the socket file so reboot is clean", async () => {
  const { dir, socket } = mkSocketPath();
  const { options } = recordingOptions();
  const stop = startControlServerOn(socket, options);
  // Give listen() a tick to chmod the socket file.
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Use rpc once so we know the socket exists/works.
  await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`);
  stop();
  // After stop, a fresh server can boot on the same path without an EADDRINUSE.
  const second = startControlServerOn(socket, options);
  try {
    const res = await rpc(socket, `${JSON.stringify({ type: "focus" })}\n`);
    assert.deepEqual(res, { ok: true });
  } finally {
    second();
    rmSync(dir, { recursive: true, force: true });
  }
});
