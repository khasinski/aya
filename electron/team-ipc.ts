// The teams:* IPC handlers, the team round runner and held-message redelivery.

import type { IpcMain } from "electron";
import type { ChatOptions } from "./intelligence-chat";
import { listTeams, saveTeam } from "./team-admin";
import type { TeamControlDeps } from "./team-control";
import { draftRole, ROLE_DRAFT_CHAT, type Chat } from "./team-draft";
import { projectBySlug } from "./team-files";
import { assignRoleLocked, openTeamPanes, presetChoices, releasePaneLocked, teamPaneDeps, type PaneHost } from "./team-panes";
import { assertTeamTextFits, panePick } from "./control-protocol";
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
  paneHost: PaneHost;
  intelligenceChat: (config: unknown, opts: ChatOptions) => Chat;
}

export function registerTeamIpc(deps: TeamIpcDeps): TeamRunner {
  const { ipcMain, team: teamDeps } = deps;
  const { teamHome } = teamDeps;
  const teamRunner = new TeamRunner(teamDeps);
  const redelivery = setInterval(
    () => void teamRunner.redeliverWaiting().catch((err) => console.warn("[aya] held team messages not retried:", err)),
    // E2E only: a spec that waits on a held message should not wait a production period.
    Number(process.env.AYA_E2E_TEAM_REDELIVERY_MS) || TEAM_REDELIVERY_MS,
  );
  deps.onBeforeQuit(() => {
    clearInterval(redelivery);
    teamRunner.stopAll();
  });
  void teamRunner.restore().catch((err) => console.warn("[aya] team rounds not restored:", err));
  ipcMain.handle("teams:start", (_e, slug: unknown, team: unknown, task: unknown, to: unknown) => {
    const optional = (value: unknown, name: string) => (value === undefined || value === null || value === "" ? undefined : requireString(value, name));
    const text = optional(task, "teams:start.task");
    if (text) assertTeamTextFits(text, "task");
    const role = optional(to, "teams:start.to");
    return teamRunner.start(
      requireString(slug, "teams:start.projectSlug"),
      requireString(team, "teams:start.team"),
      text ? { text, ...(role ? { to: role } : {}) } : undefined,
    );
  });
  for (const action of ["pause", "resume", "remove"] as const) {
    const channel = `teams:${action}`;
    ipcMain.handle(channel, (_e, slug: unknown, team: unknown) =>
      teamRunner[action](requireString(slug, `${channel}.projectSlug`), requireString(team, `${channel}.team`)),
    );
  }
  const teamProject = async (slug: unknown, channel: string): Promise<ProjectConfig> =>
    projectBySlug(await teamDeps.listProjects(), requireString(slug, `${channel}.projectSlug`));
  ipcMain.handle("teams:list", async (_e, slug: unknown) =>
    listTeams(teamHome, await teamProject(slug, "teams:list"), teamDeps.holdReason, teamDeps.roleNoteReport, teamDeps.launchNote),
  );
  ipcMain.handle("teams:save", async (_e, slug: unknown, team: unknown, create: unknown) => {
    const project = await teamProject(slug, "teams:save");
    const definition = validateTeamDefinition(team);
    await saveTeam(teamHome, project, definition, { create: create === true });
    await teamRunner.refresh(project.slug, definition.name);
  });
  ipcMain.handle("teams:release-pane", async (_e, slug: unknown, paneId: unknown) =>
    releasePaneLocked(teamDeps, (await teamProject(slug, "teams:release-pane")).slug, requireString(paneId, "teams:release-pane.paneId")),
  );
  ipcMain.handle("teams:assign", async (_e, slug: unknown, team: unknown, role: unknown, paneId: unknown) => {
    const project = await teamProject(slug, "teams:assign");
    const [teamName, roleId] = [requireString(team, "teams:assign.team"), requireString(role, "teams:assign.role")];
    const pane = paneId === null ? null : requireString(paneId, "teams:assign.paneId");
    await assignRoleLocked(teamDeps, project.slug, teamName, roleId, pane);
    return pane ? teamRunner.introduce(project.slug, teamName, roleId) : null;
  });
  ipcMain.handle("teams:draft-role", async (_e, team: unknown, roleId: unknown, config: unknown) =>
    draftRole(
      validateTeamDefinition(team, "teams:draft-role"),
      requireString(roleId, "teams:draft-role.roleId"),
      deps.intelligenceChat(config, ROLE_DRAFT_CHAT),
    ),
  );
  const panes = teamPaneDeps(teamDeps, deps.paneHost, teamRunner);
  ipcMain.handle("teams:presets", async () => presetChoices(panes, null));
  ipcMain.handle("teams:open-panes", async (_e, slug: unknown, team: unknown, picks: unknown, release: unknown) => {
    const project = await teamProject(slug, "teams:open-panes");
    const invalid = new Error("Invalid IPC payload for teams:open-panes.panes: expected [{role, target}].");
    if (!Array.isArray(picks)) throw invalid;
    const valid = picks.map((pick) => {
      try {
        return panePick(pick);
      } catch {
        throw invalid;
      }
    });
    if (release !== undefined && !Array.isArray(release)) throw new Error("Invalid IPC payload for teams:open-panes.release: expected [role].");
    const released = (release ?? []).map((role: unknown, i: number) => requireString(role, `teams:open-panes.release[${i}]`));
    // Each pick is the user's own choice in a row that shows what it replaces or moves;
    // "No pane" picks are released only once every other pick passed the check.
    return openTeamPanes(panes, project, requireString(team, "teams:open-panes.team"), valid, { replace: true, release: released });
  });
  return teamRunner;
}
