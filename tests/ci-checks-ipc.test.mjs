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
  const result = await list({ sender: {} }, { projectSlug: "project", directory: "/definitely/not/an/aya/checkout", requestId: "request-1" });
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
    projectSlug: "project", directory: "/tmp/project", targetId: "foreign-pane", checkUrl: "https://github.com/acme/repo/actions/runs/1/job/2", requestId: "preview-1",
  }), /Choose a pane from this project/);
});

test("request cancellation is bound to the invoking renderer", async () => {
  const { map, ipcMain } = handlers();
  let releaseProjects;
  const listProjects = () => new Promise((resolve) => { releaseProjects = resolve; });
  registerCiChecksIpc({ ipcMain, listProjects, sendToPane: async () => {} });
  const list = map.get("git-checks:list");
  const cancel = map.get("git-checks:cancel");
  const sender = {};
  const otherSender = {};
  const request = list({ sender }, { projectSlug: "project", directory: "/definitely/not/an/aya/checkout", requestId: "cancel-bound" });
  await new Promise((resolve) => setImmediate(resolve));
  cancel({ sender: otherSender }, "cancel-bound");
  releaseProjects([{ slug: "project", directory: "/tmp/project", tabs: [], remote: null }]);
  const result = await request;
  assert.equal(result.error, "Aya could not load pull request checks.");

  const cancelledRequest = list({ sender }, { projectSlug: "project", directory: "/definitely/not/an/aya/checkout", requestId: "cancel-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  cancel({ sender }, "cancel-owned");
  releaseProjects([{ slug: "project", directory: "/tmp/project", tabs: [], remote: null }]);
  await assert.rejects(cancelledRequest, /cancelled/);
});
