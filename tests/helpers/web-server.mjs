// A real Aya Web server on an ephemeral port, and a WebSocket client for it.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const { startWebServer } = await import("../../dist-electron/web-server.js");
const { webCredentials } = await import("../../dist-electron/web-config.js");

export const PASSWORD = "test-password-123";

function makeDistDir() {
  const dir = mkdtempSync(join(tmpdir(), "aya-web-"));
  writeFileSync(join(dir, "web.html"), "<html>aya web test</html>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "// js");
  return dir;
}

export async function startTestServer(overrides = {}) {
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

/** Opens `url`; `next()` resolves with the next JSON frame, buffered or not. */
export function wsOpen(url, cookie) {
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
