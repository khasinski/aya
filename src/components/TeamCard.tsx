import { useState } from "react";
import { heldList } from "../team-view";
import type { ProjectConfig, TeamDefinition, TeamSummary } from "../types";
import { ErrorLine, useAsyncAction } from "./use-async-action";

/** One team in the teams window: its state, pane per role, recent messages. */
export function TeamCard({
  team,
  project,
  onEdit,
  onChanged,
}: {
  team: TeamSummary;
  project: ProjectConfig;
  onEdit: (definition: TeamDefinition) => void;
  onChanged: () => Promise<void>;
}) {
  const { run, busy, error } = useAsyncAction();
  const [held, setHeld] = useState<string | null>(null);
  const act = async <T,>(work: () => Promise<T>) => {
    const result = await run(work);
    await onChanged();
    return result;
  };
  const definition = team.definition;
  return (
    <div className="aya-teams-card" data-testid={`team-${team.name}`}>
      <div className="aya-teams-card-head">
        <strong>{team.name}</strong>
        {team.paused && <span className="aya-teams-badge">paused</span>}
        <span className="aya-teams-spacer" />
        {definition && (
          <button className="aya-modal-btn" onClick={() => onEdit(definition)}>
            Edit
          </button>
        )}
        {definition && team.running && (
          <button className="aya-modal-btn" disabled={busy} onClick={() => act(() => window.aya.teamPause(project.slug, team.name))}>
            Pause
          </button>
        )}
        {definition && team.paused && (
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            disabled={busy}
            onClick={() => act(() => window.aya.teamResume(project.slug, team.name))}
          >
            Resume
          </button>
        )}
        {definition && !team.running && (
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            disabled={busy}
            onClick={async () => {
              const result = await act(() => window.aya.teamStart(project.slug, team.name));
              const list = heldList(result?.held ?? []);
              setHeld(
                !result || !list
                  ? null
                  : result.started
                    ? `Started, but not delivered: ${list}`
                    : `Not started, nothing was sent. Not ready: ${list}. Fix these panes and press Start again.`,
              );
            }}
          >
            Start
          </button>
        )}
      </div>
      <ErrorLine error={error ?? team.error} />
      {held && <div className="aya-teams-warning">{held}</div>}
      {team.repoChanged && (
        <div className="aya-teams-warning">
          The repo file changed since this team was saved. Aya keeps running the saved version.
          {team.repoDefinition && (
            <button
              className="aya-modal-btn"
              onClick={() => act(() => window.aya.teamSave(project.slug, team.repoDefinition as TeamDefinition))}
            >
              Use the repo version
            </button>
          )}
        </div>
      )}
      {definition && (
        <table className="aya-teams-roles">
          <tbody>
            {definition.roles.map((role) => (
              <tr key={role.id}>
                <td>
                  <strong>{role.id}</strong>
                  <div className="aya-teams-muted">must not {role.mustNot}</div>
                </td>
                <td className="aya-teams-muted">
                  {role.sendsTo.map((r) => (
                    <div key={r.to}>
                      → {r.to}
                      {r.what ? `: ${r.what}` : ""}
                    </div>
                  ))}
                </td>
                <td>
                  <select
                    aria-label={`Pane for ${role.id}`}
                    value={team.assignments[role.id] ?? ""}
                    onChange={async (e) => {
                      const why = await act(() => window.aya.teamAssign(project.slug, team.name, role.id, e.target.value || null));
                      setHeld(why ? `${role.id} was not told its role (${why}); it waits in its inbox` : null);
                    }}
                  >
                    <option value="">No pane</option>
                    {project.tabs.map((tab) => (
                      <option key={tab.id} value={tab.id}>
                        {tab.name}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {team.log.length > 0 && (
        <div className="aya-teams-log" aria-label={`${team.name} messages`}>
          {team.log
            .slice(-8)
            .reverse()
            .map((m) => (
              <div key={m.id} className="aya-teams-log-row">
                <span className="aya-teams-muted">
                  {new Date(m.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {m.from} → {m.to}
                  {m.commit ? ` · ${m.commit}` : ""} · {m.delivered ? "written" : "waiting in inbox"}
                </span>
                <span>{m.text}</span>
              </div>
            ))}
          <div className="aya-teams-muted">"written" means it reached the pane, not that it was read.</div>
        </div>
      )}
      {definition && Object.keys(team.assignments).length === 0 && (
        <div className="aya-modal-hint">Give each role a pane, then Start.</div>
      )}
    </div>
  );
}
