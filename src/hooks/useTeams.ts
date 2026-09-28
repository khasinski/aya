import { useCallback, useEffect, useState } from "react";
import { teamPromptKey, unassignedTeams } from "../team-view";
import type { ProjectConfig, TeamSummary } from "../types";

// Teams of every open project are re-read this often, for chips and badges.
const TEAMS_REFRESH_MS = 5000;
const EMPTY_TEAMS: TeamSummary[] = [];

interface TeamsOptions {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  activeProjectRemote: boolean;
}

export function useTeams({ projects, activeProjectId, activeProjectRemote }: TeamsOptions) {
  const [teamsByProject, setTeamsByProject] = useState<Record<string, TeamSummary[]>>({});
  const [dismissedTeamPrompts, setDismissedTeamPrompts] = useState<Set<string>>(() => new Set());

  const projectSlugsKey = projects.map((p) => p.slug).join("\n");
  const refreshTeams = useCallback(async () => {
    const slugs = projectSlugsKey ? projectSlugsKey.split("\n") : [];
    const entries = await Promise.all(
      slugs.map(async (slug) => [slug, await window.aya.teamList(slug).catch(() => [])] as const),
    );
    const next = Object.fromEntries(entries);
    // Same data, same object: the memoized tab lists skip the render.
    setTeamsByProject((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [projectSlugsKey]);
  useEffect(() => {
    void refreshTeams();
    const id = window.setInterval(() => void refreshTeams(), TEAMS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refreshTeams]);
  const assignTeamRole = useCallback(
    (team: string, role: string, paneId: string | null) => {
      if (!activeProjectId) return;
      void window.aya
        .teamAssign(activeProjectId, team, role, paneId)
        .catch((err) => console.warn("[aya] team role not assigned:", err))
        .then(() => refreshTeams());
    },
    [activeProjectId, refreshTeams],
  );
  const activeTeams = (activeProjectId && teamsByProject[activeProjectId]) || EMPTY_TEAMS;
  const teamToPrompt = activeProjectRemote
    ? undefined
    : unassignedTeams(activeTeams).find((t) => !dismissedTeamPrompts.has(teamPromptKey(activeProjectId ?? "", t.name)));

  const dismissTeamPrompt = (slug: string, team: string) =>
    setDismissedTeamPrompts((prev) => new Set(prev).add(teamPromptKey(slug, team)));
  // Teams seen in the window need no "assign roles?" prompt after it.
  const onTeamsWindowClosed = (slug: string) => {
    void window.aya
      .teamList(slug)
      .catch(() => [])
      .then((seen) =>
        setDismissedTeamPrompts((prev) => new Set([...prev, ...seen.map((t) => teamPromptKey(slug, t.name))])),
      )
      .then(() => refreshTeams());
  };

  return {
    teamsByProject,
    activeTeams,
    teamToPrompt,
    onAssignTeamRole: activeProjectRemote ? undefined : assignTeamRole,
    dismissTeamPrompt,
    onTeamsWindowClosed,
  };
}
