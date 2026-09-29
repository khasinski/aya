import { useState } from "react";
import type { PresetChoice, ProjectConfig, TeamDefinition, TeamSummary } from "../types";
import {
  messageDeliveryText,
  NEW_PANE_PREFIX,
  PANE_PREFIX,
  paneOptionLabel,
  pendingMoves,
  rolePanesSummary,
  startSummary,
  TEAM_LOG_VISIBLE,
  type PaneRole,
} from "../team-view";
import { ErrorLine, useAsyncAction } from "./use-async-action";

/** One team in the teams window: its state, pane per role, recent messages. */
export function TeamCard({
  team,
  project,
  installed,
  plays,
  onEdit,
  onChanged,
}: {
  team: TeamSummary;
  project: ProjectConfig;
  /** Presets whose CLI is installed: a role can get a new session of one. */
  installed: PresetChoice[];
  /** The role each pane of the project plays, in any team. */
  plays: Record<string, PaneRole>;
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
  // Per role, the pane picked but not applied yet: "" none, a pane id, or NEW_PANE_PREFIX + preset.
  // Sent as explicit targets, so a pane named like a preset id is still that pane.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const definition = team.definition;
  const current = (role: string) => (project.tabs.some((t) => t.id === team.assignments[role]) ? team.assignments[role] : "");
  const changes = Object.fromEntries(Object.entries(picks).filter(([role, value]) => value !== current(role)));
  const tabName = (id: string) => project.tabs.find((t) => t.id === id)?.name ?? id;
  const moves = pendingMoves(team.name, changes, plays, tabName);
  const apply = async () => {
    const result = await act(async () => {
      for (const [role, value] of Object.entries(changes)) {
        if (!value) await window.aya.teamAssign(project.slug, team.name, role, null);
      }
      const given = Object.entries(changes).flatMap(([role, value]) =>
        value ? [{ role, target: value.startsWith(NEW_PANE_PREFIX) ? value : `${PANE_PREFIX}${value}` }] : [],
      );
      return given.length ? window.aya.teamOpenPanes(project.slug, team.name, given) : { panes: [], leftWithoutPane: [] };
    });
    if (!result) return;
    setPicks({});
    setNotReached((prev) => ({ ...prev, ...Object.fromEntries(result.panes.flatMap((p) => (p.notReached ? [[p.role, p.notReached]] : []))) }));
    if (result.panes.length) setSummary(rolePanesSummary(result, team.running));
  };
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
      {team.unsaved && (
        <div className="aya-teams-warning">
          This team file is not saved in Aya yet, so no agent sees it and it cannot start. Read it, then save it to run it.
          {team.repoDefinition && (
            <button
              className="aya-modal-btn"
              onClick={() => act(() => window.aya.teamSave(project.slug, team.repoDefinition as TeamDefinition))}
            >
              Save this team
            </button>
          )}
        </div>
      )}
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
                    value={picks[role.id] ?? current(role.id)}
                    disabled={team.unsaved}
                    onChange={(e) => setPicks((prev) => ({ ...prev, [role.id]: e.target.value }))}
                  >
                    <option value="">No pane</option>
                    {project.tabs.map((tab) => (
                      <option key={tab.id} value={tab.id}>
                        {paneOptionLabel(tab.name, plays[tab.id], team.name, role.id)}
                      </option>
                    ))}
                    {installed.length > 0 && (
                      <optgroup label="New session">
                        {installed.map((p) => (
                          <option key={p.id} value={`${NEW_PANE_PREFIX}${p.id}`}>
                            New: {p.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {definition && !team.unsaved && (
        <div className="aya-teams-apply">
          {moves.map((move) => (
            <div key={move} className="aya-teams-warning">
              {move}
            </div>
          ))}
          <button className="aya-modal-btn" disabled={busy || Object.keys(changes).length === 0} onClick={apply}>
            Apply panes
          </button>
          <span className="aya-teams-muted">A role takes an open pane or a new session of a preset; no pane is closed.</span>
        </div>
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
