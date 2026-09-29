import { useState } from "react";
import type { PresetChoice, ProjectConfig, TeamDefinition, TeamSummary } from "../types";
import { TeamChat } from "./TeamChat";
import {
  NEW_PANE_PREFIX,
  PANE_PREFIX,
  paneOptionLabel,
  pendingMoves,
  rolePanesSummary,
  roleStatus,
  startSummary,
  type PaneRole,
} from "../team-view";
import { ErrorLine, useAsyncAction } from "./use-async-action";

/** One team in the teams window: its state, pane per role, recent messages. */
export function TeamCard({
  team,
  project,
  installed,
  presetNames,
  plays,
  onEdit,
  onChanged,
}: {
  team: TeamSummary;
  project: ProjectConfig;
  /** Presets whose CLI is installed: a role can get a new session of one. */
  installed: PresetChoice[];
  /** Every preset's name by id, to name the pane playing a role. */
  presetNames: Record<string, string>;
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
  const [task, setTask] = useState("");
  const start = async () => {
    const result = await act(() => window.aya.teamStart(project.slug, team.name, task.trim() || undefined));
    if (!result) return;
    setNotReached(Object.fromEntries(result.held.map((h) => [h.role, h.reason])));
    setSummary(startSummary(result));
    if (result.started) setTask("");
  };
  // Per role, the pane picked but not applied yet: "" none, a pane id, or NEW_PANE_PREFIX + preset.
  // Sent as explicit targets, so a pane named like a preset id is still that pane.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const definition = team.definition;
  const current = (role: string) => (project.tabs.some((t) => t.id === team.assignments[role]) ? team.assignments[role] : "");
  const changes = Object.fromEntries(Object.entries(picks).filter(([role, value]) => value !== current(role)));
  const tabName = (id: string) => project.tabs.find((t) => t.id === id)?.name ?? id;
  const moves = pendingMoves(team.name, changes, plays, tabName);
  const paneName = (role: string) => {
    const tab = project.tabs.find((t) => t.id === team.assignments[role]);
    return tab ? (presetNames[tab.presetId] ?? tab.name) : null;
  };
  const apply = async () => {
    const applied = changes;
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
    // A pick made while this Apply ran is the user's next one: keep it.
    setPicks((prev) => Object.fromEntries(Object.entries(prev).filter(([role, value]) => applied[role] !== value)));
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
              <>
                <input
                  className="aya-modal-input aya-teams-task"
                  aria-label={`Task for ${team.name}`}
                  placeholder="Task (optional)"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                />
                <button className="aya-modal-btn aya-modal-btn--primary" disabled={busy} onClick={start}>
                  Start
                </button>
              </>
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
        <div className="aya-teams-roles">
          {definition.roles.map((role) => {
            const status = roleStatus(team, role.id, project.tabs);
            return (
              <div key={role.id} className="aya-teams-role-row">
                <div>
                  <div className="aya-teams-role-name">
                    <strong>{role.id}</strong>
                    <span className={`aya-teams-status aya-teams-status--${status.tone}`} aria-label={`${role.id} status`}>
                      {status.text}
                    </span>
                  </div>
                  <div className="aya-teams-mustnot">
                    <span className="aya-teams-label">Must not</span> {role.mustNot}
                  </div>
                  {notReached[role.id] && (
                    <div className="aya-teams-role-alert" role="status" aria-label={`${role.id} not reached`}>
                      ⚠ Not reached: {notReached[role.id]}
                    </div>
                  )}
                </div>
                <div className="aya-teams-routes">
                  {role.sendsTo.map((r) => (
                    <div key={r.to}>
                      <span className="aya-teams-route-to">→ {r.to}</span>
                      {r.what ? `: ${r.what}` : ""}
                    </div>
                  ))}
                </div>
                <select
                  className="aya-modal-input aya-teams-pane"
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
              </div>
            );
          })}
        </div>
      )}
      {Object.keys(changes).length > 0 && (
        <div className="aya-teams-apply">
          {moves.map((move) => (
            <div key={move} className="aya-teams-warning">
              {move}
            </div>
          ))}
          <button className="aya-modal-btn aya-modal-btn--primary" disabled={busy} onClick={apply}>
            Apply panes
          </button>
          <span className="aya-teams-muted">A role takes an open pane or a new session of a preset; no pane is closed.</span>
        </div>
      )}
      {team.log.length > 0 && <TeamChat team={team.name} log={team.log} pane={paneName} />}
      {definition && Object.keys(team.assignments).length === 0 && (
        <div className="aya-modal-hint">Give each role a pane, then Start.</div>
      )}
    </div>
  );
}
