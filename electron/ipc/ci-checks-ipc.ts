import type { IpcMain } from "electron";
import type { ProjectConfig } from "../types";
import { createCiFailurePreview, getPullRequestChecks, sendCiFailurePreview } from "../ci-checks";
import { getPublishStatus } from "../git-publish";
import { requireRecord, requireString } from "../validation";

export interface CiChecksIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  listProjects: () => Promise<ProjectConfig[]>;
  sendToPane: (projectSlug: string, terminalId: string, text: string) => Promise<unknown>;
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
  deps.ipcMain.handle("git-checks:list", async (_event, raw: unknown) => {
    const request = requireRecord(raw, "git-checks:list");
    await localProject(deps, request.projectSlug);
    const directory = checkout(request.directory);
    let status: Awaited<ReturnType<typeof getPublishStatus>>;
    try { status = await getPublishStatus(directory); }
    catch {
      return {
        pullRequestUrl: null,
        pullRequestState: "unknown",
        checks: [],
        error: "Aya could not load pull request checks.",
      };
    }
    if (!status.branch || status.detached) {
      return { pullRequestUrl: null, pullRequestState: "unknown", checks: [], error: "Create a branch to view its pull request checks." };
    }
    try { return await getPullRequestChecks(directory, status.branch); }
    catch (error) {
      return {
        pullRequestUrl: null,
        pullRequestState: "unknown",
        checks: [],
        error: error instanceof Error ? error.message : "Aya could not load pull request checks.",
      };
    }
  });
  deps.ipcMain.handle("git-checks:preview", async (_event, raw: unknown) => {
    const request = requireRecord(raw, "git-checks:preview");
    const project = await localProject(deps, request.projectSlug);
    const directory = checkout(request.directory);
    const targetId = requireString(request.targetId, "git-checks:preview.targetId");
    if (!project.tabs.some((tab) => tab.id === targetId)) throw new Error("Choose a pane from this project.");
    const status = await getPublishStatus(directory);
    if (!status.branch || status.detached) throw new Error("The current branch changed. Refresh and try again.");
    return createCiFailurePreview({
      directory,
      branch: status.branch,
      checkUrl: requireString(request.checkUrl, "git-checks:preview.checkUrl"),
      projectSlug: project.slug,
      targetId,
    });
  });
  deps.ipcMain.handle("git-checks:send", async (_event, raw: unknown) => {
    const request = requireRecord(raw, "git-checks:send");
    const project = await localProject(deps, request.projectSlug);
    const targetId = requireString(request.targetId, "git-checks:send.targetId");
    if (!project.tabs.some((tab) => tab.id === targetId)) throw new Error("Choose a pane from this project.");
    await sendCiFailurePreview({
      token: requireString(request.token, "git-checks:send.token"),
      projectSlug: project.slug,
      targetId,
    }, deps.sendToPane);
  });
}
