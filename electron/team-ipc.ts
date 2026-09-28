// The teams:* IPC handlers, the team round runner and held-message redelivery.

import type { IpcMain } from "electron";
import type { ChatOptions } from "./intelligence-chat";
import { assignRole, listTeams, releasePaneEverywhere, saveTeam } from "./team-admin";
import type { TeamControlDeps } from "./team-control";
import { draftRole, ROLE_DRAFT_CHAT, type Chat } from "./team-draft";
import { projectBySlug } from "./team-files";
import { TeamRunner } from "./team-runner";
import type { ProjectConfig } from "./types";
import { requireString, validateTeamDefinition } from "./validation";

// How often held team messages are retried; a pane frees up within seconds.
export const TEAM_REDELIVERY_MS = 15_000;

export interface TeamIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** Registers a teardown for app quit (Electron's before-quit). */
  onBeforeQuit: (teardown: () => void) => void;
  team: TeamControlDeps;
  /** A chat with the configured Aya Intelligence, for teams:draft-role. */
  intelligenceChat: (config: unknown, opts: ChatOptions) => Chat;
}

/** Registers the teams:* handlers and starts redelivery; returns the runner. */
export function registerTeamIpc(deps: TeamIpcDeps): TeamRunner {
  const { ipcMain, team: teamDeps } = deps;
  const { teamHome } = teamDeps;
  const teamRunner = new TeamRunner(teamDeps);
  // Messages held for a busy or missing pane go out once it is free again.
  const redelivery = setInterval(
    () => void teamRunner.redeliverWaiting().catch((err) => console.warn("[aya] held team messages not retried:", err)),
    TEAM_REDELIVERY_MS,
  );
  deps.onBeforeQuit(() => {
    clearInterval(redelivery);
    teamRunner.stopAll();
  });
  void teamRunner.restore().catch((err) => console.warn("[aya] team rounds not restored:", err));
  const teamArgs = (slug: unknown, team: unknown, channel: string): [string, string] => [
    requireString(slug, `${channel}.projectSlug`),
    requireString(team, `${channel}.team`),
  ];
  ipcMain.handle("teams:start", (_e, slug: unknown, team: unknown) =>
    teamRunner.start(...teamArgs(slug, team, "teams:start")),
  );
  ipcMain.handle("teams:pause", (_e, slug: unknown, team: unknown) =>
    teamRunner.pause(...teamArgs(slug, team, "teams:pause")),
  );
  ipcMain.handle("teams:resume", (_e, slug: unknown, team: unknown) =>
    teamRunner.resume(...teamArgs(slug, team, "teams:resume")),
  );
  const teamProject = async (slug: unknown, channel: string): Promise<ProjectConfig> =>
    projectBySlug(await teamDeps.listProjects(), requireString(slug, `${channel}.projectSlug`));
  ipcMain.handle("teams:list", async (_e, slug: unknown) =>
    listTeams(teamHome, await teamProject(slug, "teams:list")),
  );
  ipcMain.handle("teams:save", async (_e, slug: unknown, team: unknown, create: unknown) => {
    const project = await teamProject(slug, "teams:save");
    const definition = validateTeamDefinition(team);
    await saveTeam(teamHome, project, definition, { create: create === true });
    await teamRunner.refresh(project.slug, definition.name);
  });
  ipcMain.handle("teams:release-pane", async (_e, slug: unknown, paneId: unknown) =>
    releasePaneEverywhere(
      teamHome,
      await teamProject(slug, "teams:release-pane"),
      requireString(paneId, "teams:release-pane.paneId"),
    ),
  );
  // Returns why the newly assigned pane was not told its role, or null.
  ipcMain.handle("teams:assign", async (_e, slug: unknown, team: unknown, role: unknown, paneId: unknown) => {
    const project = await teamProject(slug, "teams:assign");
    const [teamName, roleId] = [requireString(team, "teams:assign.team"), requireString(role, "teams:assign.role")];
    const pane = paneId === null ? null : requireString(paneId, "teams:assign.paneId");
    await assignRole(teamHome, project, teamName, roleId, pane);
    return pane ? teamRunner.introduce(project.slug, teamName, roleId) : null;
  });
  ipcMain.handle("teams:draft-role", async (_e, team: unknown, roleId: unknown, config: unknown) =>
    draftRole(
      validateTeamDefinition(team, "teams:draft-role"),
      requireString(roleId, "teams:draft-role.roleId"),
      deps.intelligenceChat(config, ROLE_DRAFT_CHAT),
    ),
  );
  return teamRunner;
}
