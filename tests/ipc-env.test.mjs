// env:* handlers, registered by electron/ipc/env-ipc.ts against stand-ins for Electron's objects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const { registerEnvIpc, completeDirectoryPath, MAX_PATH_COMPLETION_ENTRIES } = await import(
  "../dist-electron/ipc/env-ipc.js"
);

function setup(over = {}) {
  const handlers = new Map();
  const calls = { dialog: [], openPath: [], urls: [] };
  let clip = "";
  const window = { id: 7 };
  const webContents = { id: 8 };
  registerEnvIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    senderWindow: (e) => (e?.fromWindow ? window : null),
    dialog: {
      showOpenDialog: async (...args) => {
        calls.dialog.push(args);
        return { canceled: false, filePaths: ["/picked"] };
      },
    },
    shell: { openPath: async (p) => (calls.openPath.push(p), p.includes("bad") ? "no app for it" : "") },
    clipboard: { readText: () => clip, writeText: (t) => (clip = t) },
    home: () => "/home/test",
    openExternalUrl: async (url) => void calls.urls.push(url),
    ...over,
  });
  const call = (channel, event = {}, ...args) => handlers.get(channel)({ sender: webContents, ...event }, ...args);
  return { handlers, call, calls, window };
}

test("registers exactly the env:* channels", () => {
  const { handlers } = setup();
  assert.deepEqual([...handlers.keys()].sort(), [
    "env:clipboard-read",
    "env:clipboard-write",
    "env:complete-path",
    "env:create-dir",
    "env:cwd",
    "env:dir-exists",
    "env:expand",
    "env:git",
    "env:git-changed-files",
    "env:git-commit-files",
    "env:git-diff",
    "env:git-root",
    "env:git-worktree-add",
    "env:git-worktree-batch-add",
    "env:git-worktree-removal-info",
    "env:git-worktree-remove",
    "env:git-worktree-remove-with-branch",
    "env:git-worktree-status",
    "env:github-cli-available",
    "env:github-link",
    "env:home",
    "env:open-path",
    "env:open-url",
    "env:pick-dir",
    "env:pick-sound",
    "env:set-active-git-directory",
  ]);
});

test("git commit IPC validates a list of paths and a message", async () => {
  const { call } = setup();
  await call("env:set-active-git-directory", { fromWindow: true }, "/tmp");
  await assert.rejects(call("env:git-commit-files", { fromWindow: true }, { directory: "/tmp", paths: ["a", 4], message: "m" }), /paths must be a list/);
  assert.deepEqual(await call("env:git-commit-files", { fromWindow: true }, { directory: "/tmp", paths: ["a"], message: "" }), { ok: false, error: "Enter a commit message." });
});

test("git commit IPC rejects a request from a checkout other than the window's active selection", async () => {
  const { call } = setup();
  await call("env:set-active-git-directory", { fromWindow: true }, "/tmp/project-b");
  await assert.rejects(call("env:git-commit-files", { fromWindow: true }, {
    directory: "/tmp/project-a", paths: ["file.txt"], message: "Wrong checkout",
  }), /checkout changed/i);
});

test("git commit IPC forwards a valid request for the active checkout", async () => {
  const forwarded = [];
  const { call } = setup({ commitGitFiles: async (...args) => (forwarded.push(args), { ok: true, commit: "abc1234" }) });
  await call("env:set-active-git-directory", { fromWindow: true }, "/tmp/project");
  const result = await call("env:git-commit-files", { fromWindow: true }, {
    directory: "/tmp/project", paths: ["chosen.txt"], message: "Chosen only",
  });
  assert.deepEqual(result, { ok: true, commit: "abc1234" });
  assert.deepEqual(forwarded, [["/tmp/project", ["chosen.txt"], "Chosen only"]]);
});

test("the directory picker opens on the asking window, or alone without one, from home", async () => {
  const { call, calls, window } = setup();
  assert.equal(await call("env:pick-dir", { fromWindow: true }), "/picked");
  assert.equal(calls.dialog[0][0], window);
  assert.equal(calls.dialog[0][1].defaultPath, "/home/test");
  assert.deepEqual(calls.dialog[0][1].properties, ["openDirectory", "createDirectory"]);
  await call("env:pick-sound", { fromWindow: false });
  assert.equal(calls.dialog[1].length, 1, "no parent window");
  assert.deepEqual(calls.dialog[1][0].properties, ["openFile"]);
});

test("a cancelled picker answers null", async () => {
  const { call } = setup({ dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } });
  assert.equal(await call("env:pick-dir", {}), null);
});

test("paths: expand, exists, create, open; an open the OS refuses is an error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-env-ipc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { call, calls } = setup();
  assert.equal(await call("env:expand", {}, "~/x"), join(homedir(), "x"));
  assert.equal(await call("env:dir-exists", {}, dir), true);
  assert.equal(await call("env:dir-exists", {}, join(dir, "nope")), false);
  await call("env:create-dir", {}, join(dir, "a", "b"));
  assert.equal(existsSync(join(dir, "a", "b")), true);
  await call("env:open-path", {}, dir);
  assert.deepEqual(calls.openPath, [dir]);
  await assert.rejects(call("env:open-path", {}, join(dir, "bad")), /no app for it/);
  await assert.rejects(call("env:expand", {}, 7), /env:expand\.path/);
});

test("URLs go to openExternalUrl; the clipboard round-trips", async () => {
  const { call, calls } = setup();
  await call("env:open-url", {}, "https://example.com/");
  assert.deepEqual(calls.urls, ["https://example.com/"]);
  await call("env:clipboard-write", {}, "copied");
  assert.equal(await call("env:clipboard-read", {}), "copied");
});

test("completeDirectoryPath lists directories under the prefix, hidden ones only once a dot is typed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aya-complete-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["alpha", "alps", "beta", ".hidden"]) mkdirSync(join(dir, name));
  assert.deepEqual(await completeDirectoryPath(`${dir}/al`), [`${dir}/alpha/`, `${dir}/alps/`]);
  assert.deepEqual(await completeDirectoryPath(`${dir}/`), [`${dir}/alpha/`, `${dir}/alps/`, `${dir}/beta/`]);
  assert.deepEqual(await completeDirectoryPath(`${dir}/.h`), [`${dir}/.hidden/`]);
  assert.deepEqual(await completeDirectoryPath(`${dir}/missing/x`), []);
  assert.equal(MAX_PATH_COMPLETION_ENTRIES, 100);
});
