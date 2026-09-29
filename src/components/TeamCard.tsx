import { useState } from "react";
import type { ProjectConfig, TeamDefinition, TeamSummary } from "../types";
import { messageDeliveryText, startSummary, TEAM_LOG_VISIBLE } from "../team-view";
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
  // Why a role's pane was not reached by the last Start or assignment, per role.
  const [notReached, setNotReached] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const act = async <T,>(work: () => Promise<T>) => {
    const result = await run(work);
    await onChanged();
    return result;
  };
  const start = async () => {
    const result = await act(() => window.aya.teamStart(project.slug, team.name));
    if (!result) return;
    setNotReached(Object.fromEntries(result.held.map((h) => [h.role, h.reason])));
    setSummary(startSummary(result));
  };
  const assign = async (role: string, paneId: string | null) => {
    const why = await act(() => window.aya.teamAssign(project.slug, team.name, role, paneId));
    setNotReached(({ [role]: _, ...rest }) => (why ? { ...rest, [role]: why } : rest));
  };
  const definition = team.definition;
  return (
    <div className="aya-teams-card" data-testid={`team-${team.name}`}>
      <div className="aya-teams-card-head">
        <strong>{team.name}</strong>
        {team.paused && <span className="aya-teams-badge">paused</span>}
        <span className="aya-teams-spacer" />
        {definition && (
          <>
            <button className="aya-modal-btn" onClick={() => onEdit(definition)}>
              Edit
            </button>
            {team.running && (
              <button className="aya-modal-btn" disabled={busy} onClick={() => act(() => window.aya.teamPause(project.slug, team.name))}>
                Pause
              </button>
            )}
            {team.paused && (
              <button
                className="aya-modal-btn aya-modal-btn--primary"
                disabled={busy}
                onClick={() => act(() => window.aya.teamResume(project.slug, team.name))}
              >
                Resume
              </button>
            )}
            {!team.running && (
              <button className="aya-modal-btn aya-modal-btn--primary" disabled={busy} onClick={start}>
                Start
              </button>
            )}
          </>
        )}
      </div>
      <ErrorLine error={error ?? team.error} />
      {summary && <div className="aya-teams-warning">{summary}</div>}
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
                  {notReached[role.id] && (
                    <div className="aya-teams-role-alert" role="status" aria-label={`${role.id} not reached`}>
                      ⚠ Not reached: {notReached[role.id]}
                    </div>
                  )}
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
                    onChange={(e) => assign(role.id, e.target.value || null)}
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
            .slice(-TEAM_LOG_VISIBLE)
            .reverse()
            .map((m) => (
              <div key={m.id} className="aya-teams-log-row">
                <span className="aya-teams-muted">
                  {new Date(m.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {m.from} → {m.to}
                  {m.commit ? ` · ${m.commit}` : ""} ·{" "}
                  {messageDeliveryText(m)}
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
