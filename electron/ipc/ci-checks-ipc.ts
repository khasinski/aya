import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { ProjectConfig } from "../types";
import { createCiFailurePreview, getPullRequestChecks, sendCiFailurePreview } from "../ci-checks";
import { getPublishStatus } from "../git-publish";
import { requireRecord, requireString } from "../validation";

export interface CiChecksIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  listProjects: () => Promise<ProjectConfig[]>;
  sendToPane: (projectSlug: string, terminalId: string, text: string) => Promise<unknown>;
  onBeforeQuit?: (teardown: () => void) => void;
}

async function localProject(deps: CiChecksIpcDeps, rawSlug: unknown): Promise<ProjectConfig> {
  const slug = requireString(rawSlug, "git-checks.projectSlug");
  const project = (await deps.listProjects()).find((entry) => entry.slug === slug);
  if (!project) throw new Error("This project is no longer open.");
  if (project.remote) throw new Error("Pull request checks are available for local projects.");
  return project;
}

function checkout(raw: unknown): string {
  const directory = requireString(raw, "git-checks.directory");
  if (directory.length > 4096 || !directory.startsWith("/")) throw new Error("The current working copy could not be identified.");
  return directory;
}

export function registerCiChecksIpc(deps: CiChecksIpcDeps): void {
  const activeRequests = new Map<string, { sender: IpcMainInvokeEvent["sender"]; controller: AbortController }>();
  let quitting = false;
  const abortActiveRequests = () => {
    quitting = true;
    for (const { controller } of activeRequests.values()) controller.abort(new Error("Aya is quitting."));
  };
  deps.onBeforeQuit?.(abortActiveRequests);
  const beginRequest = (event: IpcMainInvokeEvent, rawId: unknown, channel: string) => {
    if (quitting) throw new Error("Aya is quitting.");
    const requestId = requireString(rawId, `${channel}.requestId`);
    if (requestId.length > 128) throw new Error(`${channel}.requestId is too long`);
    if (activeRequests.has(requestId)) throw new Error("This pull request check request is already running.");
    const controller = new AbortController();
    activeRequests.set(requestId, { sender: event.sender, controller });
    return {
      controller,
      finish: () => {
        if (activeRequests.get(requestId)?.controller === controller) activeRequests.delete(requestId);
      },
    };
  };
  deps.ipcMain.handle("git-checks:list", async (event, raw: unknown) => {
    const request = requireRecord(raw, "git-checks:list");
    const directory = checkout(request.directory);
    const { controller, finish } = beginRequest(event, request.requestId, "git-checks:list");
    try {
      await localProject(deps, request.projectSlug);
      let status: Awaited<ReturnType<typeof getPublishStatus>>;
      try { status = await getPublishStatus(directory, { signal: controller.signal }); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason ?? error;
        return {
          pullRequestUrl: null,
          pullRequestState: "unknown",
          checks: [],
          error: "Aya could not load pull request checks.",
        };
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!status.branch || status.detached) {
        return { pullRequestUrl: null, pullRequestState: "unknown", checks: [], error: "Create a branch to view its pull request checks." };
      }
      try { return await getPullRequestChecks(directory, status.branch, undefined, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        return {
          pullRequestUrl: null,
          pullRequestState: "unknown",
          checks: [],
          error: error instanceof Error ? error.message : "Aya could not load pull request checks.",
        };
      }
    } finally {
      finish();
    }
  });
  deps.ipcMain.handle("git-checks:cancel", (event, raw: unknown) => {
    const requestId = requireString(raw, "git-checks:cancel.requestId");
    const pending = activeRequests.get(requestId);
    if (pending?.sender === event.sender) pending.controller.abort(new Error("Pull request check refresh was cancelled."));
  });
  deps.ipcMain.handle("git-checks:preview", async (event, raw: unknown) => {
    const request = requireRecord(raw, "git-checks:preview");
    const { controller, finish } = beginRequest(event, request.requestId, "git-checks:preview");
    try {
      const project = await localProject(deps, request.projectSlug);
      const directory = checkout(request.directory);
      const targetId = requireString(request.targetId, "git-checks:preview.targetId");
      if (!project.tabs.some((tab) => tab.id === targetId)) throw new Error("Choose a pane from this project.");
      const status = await getPublishStatus(directory, { signal: controller.signal });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!status.branch || status.detached) throw new Error("The current branch changed. Refresh and try again.");
      return await createCiFailurePreview({
        directory,
        branch: status.branch,
        checkUrl: requireString(request.checkUrl, "git-checks:preview.checkUrl"),
        projectSlug: project.slug,
        targetId,
      }, undefined, controller.signal);
    } finally { finish(); }
  });
  deps.ipcMain.handle("git-checks:send", async (event, raw: unknown) => {
    const request = requireRecord(raw, "git-checks:send");
    const { controller, finish } = beginRequest(event, request.requestId, "git-checks:send");
    try {
      const project = await localProject(deps, request.projectSlug);
      const targetId = requireString(request.targetId, "git-checks:send.targetId");
      if (!project.tabs.some((tab) => tab.id === targetId)) throw new Error("Choose a pane from this project.");
      await sendCiFailurePreview({
        token: requireString(request.token, "git-checks:send.token"),
        projectSlug: project.slug,
        targetId,
      }, deps.sendToPane, undefined, controller.signal);
    } finally { finish(); }
  });
}
