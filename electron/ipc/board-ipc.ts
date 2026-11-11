import type { IpcMain } from "electron";
import {
  addBoardCard,
  addBoardColumn,
  claimBoardCard,
  deleteBoardCard,
  deleteBoardColumn,
  exportBoardToRepo,
  formatBoardPrompt,
  getBoard,
  moveBoardCard,
  releaseBoardCard,
  renameBoardColumn,
  updateBoardCard,
} from "../board";
import type { ProjectConfig } from "../types";
import { requireRecord, requireString } from "../validation";

export interface BoardIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  ayaHome: string;
  listProjects: () => Promise<ProjectConfig[]>;
  sendToPane: (projectSlug: string, terminalId: string, text: string) => Promise<unknown>;
}

async function localProject(deps: BoardIpcDeps, rawSlug: unknown): Promise<ProjectConfig> {
  const slug = requireString(rawSlug, "board.projectSlug");
  const project = (await deps.listProjects()).find((entry) => entry.slug === slug);
  if (!project) throw new Error("This project is no longer open.");
  if (project.remote) throw new Error("Kanban board is available for local projects only.");
  return project;
}

export function registerBoardIpc(deps: BoardIpcDeps): void {
  const { ipcMain, ayaHome } = deps;

  ipcMain.handle("board:get", async (_event, rawSlug: unknown) => {
    const project = await localProject(deps, rawSlug);
    return getBoard(ayaHome, project);
  });

  ipcMain.handle("board:add-card", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:add-card");
    const project = await localProject(deps, req.projectSlug);
    const title = requireString(req.title, "board:add-card.title");
    const description = typeof req.description === "string" ? req.description : undefined;
    const columnId = typeof req.columnId === "string" && req.columnId ? req.columnId : undefined;
    const assignee = typeof req.assignee === "string" && req.assignee ? req.assignee : undefined;
    const { board } = await addBoardCard(ayaHome, project, { title, description, columnId, assignee });
    return board;
  });

  ipcMain.handle("board:update-card", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:update-card");
    const project = await localProject(deps, req.projectSlug);
    const cardId = requireString(req.cardId, "board:update-card.cardId");
    const title = typeof req.title === "string" ? req.title : undefined;
    const description = typeof req.description === "string" ? req.description : undefined;
    const columnId = typeof req.columnId === "string" ? req.columnId : undefined;
    const assignee =
      req.assignee === null ? null : typeof req.assignee === "string" ? req.assignee : undefined;
    const { board } = await updateBoardCard(ayaHome, project, cardId, {
      title,
      description,
      columnId,
      assignee,
    });
    return board;
  });

  ipcMain.handle("board:move-card", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:move-card");
    const project = await localProject(deps, req.projectSlug);
    const cardId = requireString(req.cardId, "board:move-card.cardId");
    const columnId = requireString(req.columnId, "board:move-card.columnId");
    const index =
      typeof req.index === "number" && Number.isInteger(req.index) && req.index >= 0
        ? req.index
        : undefined;
    const { board } = await moveBoardCard(ayaHome, project, cardId, columnId, index);
    return board;
  });

  ipcMain.handle("board:delete-card", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:delete-card");
    const project = await localProject(deps, req.projectSlug);
    const cardId = requireString(req.cardId, "board:delete-card.cardId");
    const { board } = await deleteBoardCard(ayaHome, project, cardId);
    return board;
  });

  ipcMain.handle("board:claim-card", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:claim-card");
    const project = await localProject(deps, req.projectSlug);
    const cardId = requireString(req.cardId, "board:claim-card.cardId");
    const paneName = requireString(req.paneName, "board:claim-card.paneName");
    const paneId = typeof req.paneId === "string" && req.paneId ? req.paneId : undefined;
    const replace = req.replace === true;
    const { board } = await claimBoardCard(ayaHome, project, cardId, {
      paneId,
      paneName,
      replace,
    });
    return board;
  });

  ipcMain.handle("board:release-card", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:release-card");
    const project = await localProject(deps, req.projectSlug);
    const cardId = requireString(req.cardId, "board:release-card.cardId");
    const { board } = await releaseBoardCard(ayaHome, project, cardId, { force: true });
    return board;
  });

  ipcMain.handle("board:add-column", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:add-column");
    const project = await localProject(deps, req.projectSlug);
    const title = requireString(req.title, "board:add-column.title");
    const { board } = await addBoardColumn(ayaHome, project, title);
    return board;
  });

  ipcMain.handle("board:rename-column", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:rename-column");
    const project = await localProject(deps, req.projectSlug);
    const columnId = requireString(req.columnId, "board:rename-column.columnId");
    const title = requireString(req.title, "board:rename-column.title");
    const { board } = await renameBoardColumn(ayaHome, project, columnId, title);
    return board;
  });

  ipcMain.handle("board:delete-column", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:delete-column");
    const project = await localProject(deps, req.projectSlug);
    const columnId = requireString(req.columnId, "board:delete-column.columnId");
    return deleteBoardColumn(ayaHome, project, columnId);
  });

  ipcMain.handle("board:export-repo", async (_event, rawSlug: unknown) => {
    const project = await localProject(deps, rawSlug);
    return exportBoardToRepo(ayaHome, project);
  });

  ipcMain.handle("board:send-to-pane", async (_event, rawReq: unknown) => {
    const req = requireRecord(rawReq, "board:send-to-pane");
    const project = await localProject(deps, req.projectSlug);
    const cardId = requireString(req.cardId, "board:send-to-pane.cardId");
    const targetId = requireString(req.targetId, "board:send-to-pane.targetId");
    const target = project.tabs.find((tab) => tab.id === targetId);
    if (!target) throw new Error("Choose a pane from this project.");
    const { board, card } = await claimBoardCard(ayaHome, project, cardId, {
      paneId: target.id,
      paneName: target.name,
      replace: true,
    });
    const prompt = formatBoardPrompt(card);
    await deps.sendToPane(project.slug, target.id, prompt);
    return board;
  });
}
