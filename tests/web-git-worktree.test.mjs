// Aya Web (experimental): the status bar's git surface asks for the ACTIVE
// TERMINAL's checkout, which for a worktree tab is a directory outside the
// project. The browser bridge must forward that directory as-is - the renderer
// code is shared with Electron, so if the bridge only served the project dir,
// the web mode would silently keep showing the main checkout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";

const { startWebServer } = await import("../dist-electron/web-server.js");
const { webCredentials } = await import("../dist-electron/web-config.js");
const { captureIpcHandlers } = await import("../dist-electron/web-ipc.js");
const { getGitInfo, getGitDiff } = await import("../dist-electron/git.js");

const PASSWORD = "test-password-123";

// Register the git channels the way main.ts does, through the same capture
// wrapper the web bridge reads from (no Electron here, so ipcMain is a stub).
const stubIpcMain = { handle: () => {} };
captureIpcHandlers(stubIpcMain);
stubIpcMain.handle("env:git", (_e, directory) => getGitInfo(directory));
stubIpcMain.handle("env:git-diff", (_e, directory) => getGitDiff(directory));

/** A repo on "feature/foo" plus a worktree on "wt/bar", each with its own
 *  distinct modification of the same tracked file. */
function makeRepoWithWorktree() {
  const root = mkdtempSync(join(tmpdir(), "aya-web-git-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "feature/foo");
  writeFileSync(join(repo, "committed.txt"), "one\ntwo\n");
  git("add", "committed.txt");
  git("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init");
  writeFileSync(join(repo, "committed.txt"), "one\ntwoMAIN\n");
  const worktree = join(root, "wt-bar");
  git("worktree", "add", "-q", "-b", "wt/bar", worktree);
  writeFileSync(join(worktree, "committed.txt"), "one\ntwoWT\n");
  return { root, repo, worktree };
}

async function startTestServer() {
  const distDir = mkdtempSync(join(tmpdir(), "aya-web-"));
  writeFileSync(join(distDir, "web.html"), "<html>aya web test</html>");
  const config = {
    enabled: true,
    port: 0,
    host: "127.0.0.1",
    user: "tester",
    ...webCredentials(PASSWORD, false),
  };
  const handle = await startWebServer({
    appVersion: "0.0.0-test",
    isDev: false,
    distDir,
    getConfig: () => config,
  });
  return {
    handle,
    base: `http://127.0.0.1:${handle.port}`,
    cleanup: async () => {
      await handle.close();
      rmSync(distDir, { recursive: true, force: true });
    },
  };
}

function wsOpen(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } });
    const frames = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.on("open", () =>
      resolve({
        ws,
        next: () =>
          new Promise((resolveNext) => {
            const buffered = frames.shift();
            if (buffered) resolveNext(buffered);
            else waiters.push(resolveNext);
          }),
      }),
    );
    ws.on("error", reject);
  });
}

test("the web bridge reads a worktree directory, not just the project dir", async () => {
  const { root, repo, worktree } = makeRepoWithWorktree();
  const { base, cleanup } = await startTestServer();
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "tester", password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const { ws, next } = await wsOpen(base.replace("http:", "ws:") + "/ws", cookie);
    try {
      await next(); // hello

      const invoke = async (id, channel, directory) => {
        ws.send(JSON.stringify({ t: "invoke", id, channel, args: [directory] }));
        const frame = await next();
        assert.equal(frame.ok, true, `${channel} failed: ${frame.error}`);
        return frame.value;
      };

      // Project directory: its own branch and its own change.
      assert.deepEqual(await invoke(1, "env:git", repo), {
        branch: "feature/foo",
        dirty: 1,
      });
      assert.match(await invoke(2, "env:git-diff", repo), /twoMAIN/);

      // Worktree directory: the branch and diff a worktree tab must show.
      assert.deepEqual(await invoke(3, "env:git", worktree), {
        branch: "wt/bar",
        dirty: 1,
      });
      const worktreeDiff = await invoke(4, "env:git-diff", worktree);
      assert.match(worktreeDiff, /twoWT/);
      assert.doesNotMatch(worktreeDiff, /twoMAIN/);
    } finally {
      ws.close();
    }
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
