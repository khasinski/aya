// Aya Web server: login auth (cookie, rate limit, origin check), static
// serving with traversal protection, and the WebSocket invoke/result/event
// bridge. Drives a real server on an ephemeral port — no Electron needed
// (window-scoped channels are overridden and unlisted invokes are denied).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PASSWORD, startTestServer, wsOpen } from "./helpers/web-server.mjs";
import {
  IMMUTABLE_MAX_AGE_S,
  SESSION_TOKEN_BYTES,
  WEB_ALLOWED_CHANNELS,
  WEB_BRIDGE_INVOKE_CHANNELS,
  WEB_DENIED_CHANNELS,
  WEB_OVERRIDE_CHANNELS,
  dispatchWebInvoke,
} from "../dist-electron/web-server.js";
import { captureIpcHandlers } from "../dist-electron/ipc/web-capture.js";

async function login(base, user = "tester", password = PASSWORD, headers = {}) {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ user, password }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? null;
  return { res, cookie };
}

test("login sets a session cookie and /api/me honors it", async () => {
  const { base, cleanup } = await startTestServer();
  try {
    assert.equal((await fetch(`${base}/api/me`)).status, 401);

    const { res, cookie } = await login(base);
    assert.equal(res.status, 200);
    assert.ok(cookie?.startsWith("aya_web_session="));
    assert.match(res.headers.get("set-cookie"), /HttpOnly/);
    assert.match(res.headers.get("set-cookie"), /SameSite=Strict/);

    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user, "tester");

    // Logout invalidates the session.
    await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { cookie } })).status,
      401,
    );
  } finally {
    await cleanup();
  }
});

test("wrong credentials are rejected and rate-limited", async () => {
  const { base, cleanup } = await startTestServer();
  try {
    assert.equal((await login(base, "tester", "nope")).res.status, 401);
    assert.equal((await login(base, "wrong-user", PASSWORD)).res.status, 401);
    // Exhaust the failure budget (2 used above, limit is 10)...
    for (let i = 0; i < 8; i++) {
      await login(base, "tester", "nope");
    }
    // ...now even the CORRECT password is throttled for this address.
    assert.equal((await login(base)).res.status, 429);
  } finally {
    await cleanup();
  }
});

test("cross-origin logins are refused", async () => {
  const { base, cleanup } = await startTestServer();
  try {
    const { res } = await login(base, "tester", PASSWORD, {
      Origin: "http://evil.example",
    });
    assert.equal(res.status, 403);
    // Same-host origin is fine.
    const ok = await login(base, "tester", PASSWORD, {
      Origin: base,
    });
    assert.equal(ok.res.status, 200);
  } finally {
    await cleanup();
  }
});

test("serves the web entry point and blocks path traversal", async () => {
  const { base, cleanup } = await startTestServer();
  try {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /aya web test/);
    assert.match(index.headers.get("content-type"), /text\/html/);

    const asset = await fetch(`${base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /immutable/);

    const traversal = await fetch(`${base}/assets/..%2f..%2fweb-secret`);
    assert.notEqual(traversal.status, 200);
    assert.equal((await fetch(`${base}/no-such-file`)).status, 404);
  } finally {
    await cleanup();
  }
});

test("websocket requires a session and speaks the bridge protocol", async () => {
  const { base, handle, cleanup } = await startTestServer();
  const wsUrl = base.replace("http:", "ws:") + "/ws";
  try {
    // No cookie -> upgrade refused.
    await assert.rejects(wsOpen(wsUrl, null));

    const { cookie } = await login(base);
    const { ws, next } = await wsOpen(wsUrl, cookie);
    try {
      const hello = await next();
      assert.equal(hello.t, "hello");
      assert.equal(hello.user, "tester");
      assert.equal(hello.version, "0.0.0-test");

      // Overridden channel (no Electron behind it).
      ws.send(
        JSON.stringify({
          t: "invoke",
          id: 1,
          channel: "windows:list-others",
          args: [],
        }),
      );
      const listed = await next();
      assert.deepEqual(listed, { t: "result", id: 1, ok: true, value: [] });

      // A raw authenticated client cannot invoke a captured desktop-only
      // channel by bypassing bridge.ts.
      ws.send(
        JSON.stringify({
          t: "invoke",
          id: 2,
          channel: "env:clipboard-read",
          args: [],
        }),
      );
      const denied = await next();
      assert.deepEqual(denied, {
        t: "result",
        id: 2,
        ok: false,
        error: "Not available in Aya Web",
      });

      // Unlisted channel -> clean denial, socket stays usable.
      ws.send(
        JSON.stringify({ t: "invoke", id: 3, channel: "nope:nope", args: [] }),
      );
      const failed = await next();
      assert.equal(failed.ok, false);
      assert.equal(failed.error, "Not available in Aya Web");

      // Server push reaches the client.
      handle.broadcast("pty:event", { ptyId: "p1", type: "data", data: "x" });
      const event = await next();
      assert.equal(event.t, "event");
      assert.equal(event.channel, "pty:event");
      assert.equal(event.payload.ptyId, "p1");
      assert.equal(handle.clientCount(), 1);
    } finally {
      ws.close();
    }
  } finally {
    await cleanup();
  }
});

test("each Aya Web socket supplies a distinct sender identity for pane-scoped history searches", async () => {
  const ipcMain = { handle() {} };
  captureIpcHandlers(ipcMain);
  ipcMain.handle("harness:search", (event, _request, _requestId, paneId) => ({
    senderId: event.sender.id,
    paneId,
  }));
  const { base, cleanup } = await startTestServer();
  const wsUrl = base.replace("http:", "ws:") + "/ws";
  try {
    const { cookie } = await login(base);
    const a = await wsOpen(wsUrl, cookie);
    const b = await wsOpen(wsUrl, cookie);
    try {
      await a.next();
      await b.next();
      a.ws.send(JSON.stringify({
        t: "invoke", id: 1, channel: "harness:search", args: [{}, "a", "pane-1"],
      }));
      b.ws.send(JSON.stringify({
        t: "invoke", id: 1, channel: "harness:search", args: [{}, "b", "pane-1"],
      }));
      const [fromA, fromB] = await Promise.all([a.next(), b.next()]);
      assert.deepEqual(fromA.value.paneId, "pane-1");
      assert.deepEqual(fromB.value.paneId, "pane-1");
      assert.ok(Number.isSafeInteger(fromA.value.senderId));
      assert.ok(Number.isSafeInteger(fromB.value.senderId));
      assert.notEqual(fromA.value.senderId, fromB.value.senderId);
    } finally {
      a.ws.close();
      b.ws.close();
    }
  } finally {
    await cleanup();
  }
});

test("web allowlist exactly tracks bridge invokes plus existing overrides", () => {
  const bridgeSource = readFileSync(
    new URL("../src/web/bridge.ts", import.meta.url),
    "utf8",
  );
  const bridgeCalls = [...bridgeSource.matchAll(/\binv\("([^"]+)"\)/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual([...WEB_BRIDGE_INVOKE_CHANNELS].sort(), bridgeCalls);

  const expectedAllowed = [...new Set([
    ...bridgeCalls,
    ...WEB_OVERRIDE_CHANNELS,
  ])].filter((channel) => !WEB_DENIED_CHANNELS.has(channel)).sort();
  assert.deepEqual([...WEB_ALLOWED_CHANNELS].sort(), expectedAllowed);
});

test("desktop-only channels are denied while browser-safe settings saves stay available", async () => {
  const denied = [
    "machines:status",
    "machines:setup",
    "machines:command",
    "machines:configure",
    "machines:discover",
    "web:configure",
    "web:regenerate-password",
    "updates:install",
    "app:install-cli",
    "intelligence:pull-ollama-model",
    "mic:request",
    "pty-host:restart",
    "pty-host:stop-others",
    "usage-hook:install",
    "usage-hook:uninstall",
    "status-hook:install",
    "status-hook:uninstall",
  ];
  const allowed = ["presets:save", "themes:save", "snippets:save", "env:create-dir"];
  const handlers = new Map();
  const ipcMain = { handle(channel, handler) { handlers.set(channel, handler); } };
  captureIpcHandlers(ipcMain);
  let calls = 0;
  for (const channel of [...denied, ...allowed]) {
    ipcMain.handle(channel, async () => { calls += 1; return `handled:${channel}`; });
  }

  for (const channel of denied) {
    assert.equal(WEB_DENIED_CHANNELS.has(channel), true, `${channel} must remain explicitly denied`);
    await assert.rejects(dispatchWebInvoke(channel, []), { message: "Not available in Aya Web" });
  }
  assert.equal(calls, 0, "denied calls must not reach captured desktop handlers");

  for (const channel of allowed) {
    assert.equal(WEB_DENIED_CHANNELS.has(channel), false, `${channel} must remain usable in Aya Web`);
    assert.equal(await dispatchWebInvoke(channel, []), `handled:${channel}`);
  }
  assert.equal(calls, allowed.length);
});

test("raw Aya Web invokes cannot register or use prompt-attachment authority", async () => {
  let invoked = 0;
  let clipboardReads = 0;
  const ipcMain = { handle(channel, handler) { this.handlers.set(channel, handler); }, handlers: new Map() };
  captureIpcHandlers(ipcMain);
  for (const channel of [
    "prompt-attachments:register-drop",
    "prompt-attachments:register-paste",
    "prompt-attachments:drop",
    "prompt-attachments:context-menu-image",
  ]) ipcMain.handle(channel, () => { invoked += 1; });
  ipcMain.handle("prompt-attachments:clipboard-image", () => { invoked += 1; clipboardReads += 1; });

  const { base, cleanup } = await startTestServer();
  try {
    const { cookie } = await login(base);
    const { ws, next } = await wsOpen(base.replace("http:", "ws:") + "/ws", cookie);
    try {
      await next(); // hello
      for (const [id, channel] of [
        [10, "prompt-attachments:register-drop"],
        [11, "prompt-attachments:drop"],
        [12, "prompt-attachments:register-paste"],
        [13, "prompt-attachments:clipboard-image"],
        [14, "prompt-attachments:context-menu-image"],
      ]) {
        ws.send(JSON.stringify({ t: "invoke", id, channel, args: ["pane", [{ path: "/private/key" }]] }));
        const result = await next();
        assert.equal(result.id, id);
        assert.equal(result.ok, false);
        assert.equal(result.error, "Not available in Aya Web");
      }
      assert.equal(invoked, 0);
      assert.equal(clipboardReads, 0);
    } finally { ws.close(); }
  } finally { await cleanup(); }
});

test("session tokens are 32 random bytes; hashed assets cache for a year", () => {
  assert.equal(SESSION_TOKEN_BYTES, 32);
  assert.equal(IMMUTABLE_MAX_AGE_S, 31_536_000);
});
