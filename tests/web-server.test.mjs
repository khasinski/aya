// Aya Web server: login auth (cookie, rate limit, origin check), static
// serving with traversal protection, and the WebSocket invoke/result/event
// bridge. Drives a real server on an ephemeral port — no Electron needed
// (window-scoped channels are overridden, everything else is registry-based
// and the registry is empty here, so unknown channels must error cleanly).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const { startWebServer } = await import("../dist-electron/web-server.js");
const { webCredentials } = await import("../dist-electron/web-config.js");

const PASSWORD = "test-password-123";

function makeDistDir() {
  const dir = mkdtempSync(join(tmpdir(), "aya-web-"));
  writeFileSync(join(dir, "web.html"), "<html>aya web test</html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "// js");
  return dir;
}

async function startTestServer(overrides = {}) {
  const distDir = makeDistDir();
  const config = {
    enabled: true,
    port: 0,
    host: "127.0.0.1",
    user: "tester",
    ...webCredentials(PASSWORD, false),
    ...overrides,
  };
  const handle = await startWebServer({
    appVersion: "0.0.0-test",
    isDev: false,
    distDir,
    getConfig: () => config,
  });
  const base = `http://127.0.0.1:${handle.port}`;
  return {
    handle,
    base,
    cleanup: async () => {
      await handle.close();
      rmSync(distDir, { recursive: true, force: true });
    },
  };
}

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

function wsOpen(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: cookie ? { cookie } : {} });
    const frames = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.on("open", () => resolve({
      ws,
      next: () =>
        new Promise((resolveNext) => {
          const buffered = frames.shift();
          if (buffered) resolveNext(buffered);
          else waiters.push(resolveNext);
        }),
    }));
    ws.on("error", reject);
  });
}

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

      // Unknown channel -> clean error result, socket stays usable.
      ws.send(
        JSON.stringify({ t: "invoke", id: 2, channel: "nope:nope", args: [] }),
      );
      const failed = await next();
      assert.equal(failed.ok, false);
      assert.match(failed.error, /Unknown channel/);

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
