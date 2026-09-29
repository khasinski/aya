import { useCallback, useEffect, useState } from "react";
import { DEFAULT_CADENCE_MINUTES } from "../team-edit";
import { paneRoles } from "../team-view";
import type { AyaIntelligenceConfig, PresetChoice, ProjectConfig, TeamDefinition, TeamSummary } from "../types";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";
import { TeamCard } from "./TeamCard";
import { TeamEditor } from "./TeamEditor";
import { ErrorLine, useAsyncAction } from "./use-async-action";

// While open, the log and assignments refresh at this pace.
const REFRESH_MS = 3000;

/** The pair that ran the game project's 22-round UX review. */
const TWO_ROLE_TEMPLATE: TeamDefinition = {
  name: "review",
  roles: [
    {
      id: "reviewer",
      sendsTo: [{ to: "implementer", what: "findings with the screen state as proof" }],
      mustNot: "edit code",
      responsibilities:
        "Checks the running app each round and reports what a user would get wrong, with the screen state as proof.",
    },
    {
      id: "implementer",
      sendsTo: [{ to: "reviewer", what: "answers and the commit to check" }],
      mustNot: "leave a report unanswered",
      responsibilities: "Fixes findings, answers every report, and names the commit to check.",
    },
  ],
  cadence: { role: "reviewer", minutes: DEFAULT_CADENCE_MINUTES },
  protocol:
    "Findings are hypotheses with a measurement request, not facts. Number rounds and mark items [reported -> confirmed]. Reports are one-way unless a question is asked.",
};

interface Props {
  project: ProjectConfig;
  intelligence: AyaIntelligenceConfig;
  onClose: () => void;
}

export function TeamsModal({ project, intelligence, onClose }: Props) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [editing, setEditing] = useState<{ team: TeamDefinition; isNew: boolean } | null>(null);
  const [installed, setInstalled] = useState<PresetChoice[]>([]);
  const list = useAsyncAction();
  const { run } = list;

  const reload = useCallback(async () => {
    const next = await run(() => window.aya.teamList(project.slug));
    if (next) setTeams(next);
  }, [project.slug, run]);

  useEffect(() => {
    void window.aya
      .teamPresets()
      .then((all) => setInstalled(all.filter((p) => p.installed)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  return (
    <div
      className="aya-modal-backdrop"
      onMouseDown={markBackdropMouseDown}
      onClick={(e) => closeFromBackdropClick(e, onClose)}
    >
      <section
        className="aya-modal aya-teams-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Teams"
        onClick={(e) => e.stopPropagation()}
      >
        {editing ? (
          <TeamEditor
            initial={editing.team}
            isNew={editing.isNew}
            intelligence={intelligence}
            onCancel={() => setEditing(null)}
            onSave={async (team) => {
              await window.aya.teamSave(project.slug, team, editing.isNew);
              setEditing(null);
              await reload();
            }}
          />
        ) : (
          <>
            <div className="aya-modal-title">Teams · {project.name}</div>
            <div className="aya-modal-hint">
              Defined in .aya/teams/ in the repo. Which pane plays which role stays on this machine.
            </div>
            <ErrorLine error={list.error} />
            {teams.length === 0 && <div className="aya-modal-hint">No team yet.</div>}
            {teams.map((team) => (
              <TeamCard
                key={team.name}
                team={team}
                project={project}
                installed={installed}
                plays={paneRoles(teams)}
                onEdit={(definition) => setEditing({ team: definition, isNew: false })}
                onChanged={reload}
              />
            ))}
            <div className="aya-modal-actions">
              <button
                className="aya-modal-btn"
                onClick={() => setEditing({ team: { ...TWO_ROLE_TEMPLATE, name: "" }, isNew: true })}
              >
                New team
              </button>
              <button className="aya-modal-btn aya-modal-btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
