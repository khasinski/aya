import type { IpcMain } from "electron";
import type { ProjectConfig } from "../types";
import { clearSentDiffComments, deleteDiffComment, editDiffComment, addDiffComment, listDiffComments, sendDiffComments, validateDiffComment } from "../diff-comments-store";
import { reviewPrompt, reviewPtyPayload } from "../diff-comments-prompt";
import { requireRecord, requireString } from "../validation";

export interface DiffCommentsIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  ayaHome: string;
  listProjects: () => Promise<ProjectConfig[]>;
  /** This must use the same guarded pane-send path as Aya's CLI. */
  sendToPane: (projectSlug: string, terminalId: string, text: string) => Promise<unknown>;
}

async function localProject(deps: DiffCommentsIpcDeps, rawSlug: unknown): Promise<ProjectConfig> {
  const slug = requireString(rawSlug, "diff-comments.projectSlug");
  const project = (await deps.listProjects()).find((entry) => entry.slug === slug);
  if (!project) throw new Error("This project is no longer open.");
  if (project.remote) throw new Error("Comments are available for local project diffs.");
  return project;
}

function commentId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!/^[a-f0-9]{16,64}$/i.test(id)) throw new Error("Invalid saved comment.");
  return id;
}

export function registerDiffCommentsIpc(deps: DiffCommentsIpcDeps): void {
  const { ipcMain, ayaHome } = deps;
  ipcMain.handle("diff-comments:list", async (_event, rawSlug: unknown) => {
    const project = await localProject(deps, rawSlug);
    return listDiffComments(ayaHome, project.slug);
  });
  ipcMain.handle("diff-comments:add", async (_event, rawSlug: unknown, rawComment: unknown) => {
    const project = await localProject(deps, rawSlug);
    const comment = validateDiffComment(rawComment);
    return addDiffComment(ayaHome, project.slug, comment);
  });
  ipcMain.handle("diff-comments:edit", async (_event, rawSlug: unknown, rawId: unknown, rawNote: unknown) => {
    const project = await localProject(deps, rawSlug);
    const id = commentId(rawId, "diff-comments.id");
    const note = requireString(rawNote, "diff-comments.note").trim();
    if (!note) throw new Error("Write a comment before saving it.");
    return editDiffComment(ayaHome, project.slug, id, note);
  });
  ipcMain.handle("diff-comments:delete", async (_event, rawSlug: unknown, rawId: unknown) => {
    const project = await localProject(deps, rawSlug);
    return deleteDiffComment(ayaHome, project.slug, commentId(rawId, "diff-comments.id"));
  });
  ipcMain.handle("diff-comments:clear-sent", async (_event, rawSlug: unknown) => {
    const project = await localProject(deps, rawSlug);
    return clearSentDiffComments(ayaHome, project.slug);
  });
  ipcMain.handle("diff-comments:send", async (_event, rawRequest: unknown) => {
    const request = requireRecord(rawRequest, "diff-comments:send");
    const project = await localProject(deps, request.projectSlug);
    const targetId = requireString(request.targetId, "diff-comments:send.targetId");
    const target = project.tabs.find((tab) => tab.id === targetId);
    if (!target) throw new Error("Choose a pane from this project.");
    const checkout = requireString(request.checkout, "diff-comments:send.checkout");
    if (checkout.length > 4096 || !checkout.startsWith("/")) throw new Error("The current working copy could not be identified.");
    if (!Array.isArray(request.commentIds) || request.commentIds.length === 0 || request.commentIds.length > 200) {
      throw new Error("Choose at least one comment to send.");
    }
    const ids = request.commentIds.map((id) => commentId(id, "diff-comments:send.commentId"));
    if (new Set(ids).size !== ids.length) throw new Error("The selected comments changed. Review them and try again.");
    return sendDiffComments(ayaHome, project.slug, ids, target.name, async (comments) => {
      const prompt = reviewPtyPayload(reviewPrompt(comments, checkout));
      await deps.sendToPane(project.slug, targetId, prompt);
    });
  });
}
