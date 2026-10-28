import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectConfig, TeamSummary } from "../types";

// Teams of every open project are re-read this often, for chips and badges.
export const TEAMS_REFRESH_MS = 5000;
const EMPTY_TEAMS: TeamSummary[] = [];

interface TeamsOptions {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  activeProjectRemote: boolean;
}

export function useTeams({ projects, activeProjectId, activeProjectRemote }: TeamsOptions) {
  const [teamsByProject, setTeamsByProject] = useState<Record<string, TeamSummary[]>>({});
  const refreshGeneration = useRef(0);
  const refreshesInFlight = useRef(0);
  const currentProjectSlugs = useRef("");

  const projectSlugsKey = projects.map((p) => p.slug).join("\n");
  currentProjectSlugs.current = projectSlugsKey;
  const refreshTeams = useCallback((force = false) => {
    if (!force && refreshesInFlight.current > 0) return Promise.resolve();
    const generation = ++refreshGeneration.current;
    const slugsKey = projectSlugsKey;
    const slugs = slugsKey ? slugsKey.split("\n") : [];
    refreshesInFlight.current++;
    return Promise.all(slugs.map(async (slug) => [slug, await window.aya.teamList(slug).catch(() => null)] as const))
      .then((entries) => {
        if (generation !== refreshGeneration.current || slugsKey !== currentProjectSlugs.current) return;
        setTeamsByProject((prev) => {
          const next = { ...prev };
          for (const [slug, teams] of entries) if (teams !== null) next[slug] = teams;
          for (const slug of slugs) if (!(slug in next)) next[slug] = [];
          return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
        });
      })
      .finally(() => { refreshesInFlight.current--; });
  }, [projectSlugsKey]);
  const currentRefreshTeams = useRef(refreshTeams);
  currentRefreshTeams.current = refreshTeams;
  useEffect(() => {
    // A changed project list must get a trailing read even if an older batch is in flight.
    void refreshTeams(true);
    const id = window.setInterval(() => void refreshTeams(), TEAMS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [projectSlugsKey, refreshTeams]);
  const assignTeamRole = useCallback(
    (team: string, role: string, paneId: string | null) => {
      if (!activeProjectId) return;
      void window.aya
        .teamAssign(activeProjectId, team, role, paneId)
        .catch((err) => console.warn("[aya] team role not assigned:", err))
      .then(() => {
          // The assigned project may still be open after the project list changes.
          // Refresh the current scope so a batch that started before the assignment
          // cannot leave its chips stale until the next interval tick.
          if (currentProjectSlugs.current.split("\n").includes(activeProjectId)) return currentRefreshTeams.current(true);
        });
    },
    [activeProjectId],
  );
  const activeTeams = (activeProjectId && teamsByProject[activeProjectId]) || EMPTY_TEAMS;
  // Closing the Teams window refreshes definitions and role chips.
  const onTeamsWindowClosed = (slug: string) => {
    void slug;
    void refreshTeams(true);
  };

  return {
    teamsByProject,
    activeTeams,
    onAssignTeamRole: activeProjectRemote ? undefined : assignTeamRole,
    onTeamsWindowClosed,
  };
}
