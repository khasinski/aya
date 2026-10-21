import { test } from "node:test";
import assert from "node:assert/strict";

const { registerCiChecksIpc } = await import("../dist-electron/ipc/ci-checks-ipc.js");

function handlers() {
  const map = new Map();
  return { map, ipcMain: { handle: (channel, handler) => map.set(channel, handler) } };
}

test("a failed local status lookup becomes a safe result instead of an IPC exception", async () => {
  const { map, ipcMain } = handlers();
  registerCiChecksIpc({ ipcMain, listProjects: async () => [{ slug: "project", directory: "/tmp/project", tabs: [], remote: null }], sendToPane: async () => {} });
  const list = map.get("git-checks:list");
  assert.equal(typeof list, "function");
  const result = await list({}, { projectSlug: "project", directory: "/definitely/not/an/aya/checkout" });
  assert.deepEqual(result, {
    pullRequestUrl: null,
    pullRequestState: "unknown",
    checks: [],
    error: "Aya could not load pull request checks.",
  });
});

test("check previews cannot target a pane outside the selected project", async () => {
  const { map, ipcMain } = handlers();
  registerCiChecksIpc({ ipcMain, listProjects: async () => [{ slug: "project", directory: "/tmp/project", tabs: [], remote: null }], sendToPane: async () => {} });
  const preview = map.get("git-checks:preview");
  assert.equal(typeof preview, "function");
  await assert.rejects(preview({}, {
    projectSlug: "project", directory: "/tmp/project", targetId: "foreign-pane", checkUrl: "https://github.com/acme/repo/actions/runs/1/job/2",
  }), /Choose a pane from this project/);
});
