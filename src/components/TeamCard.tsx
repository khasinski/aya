import { useState } from "react";
import type { PresetChoice, ProjectConfig, TeamDefinition, TeamStartResult, TeamSummary, WaitingPanes } from "../types";
import { TeamChat } from "./TeamChat";
import {
  NEW_PANE_PREFIX,
  PANE_PREFIX,
  paneOptionLabel,
  pendingMoves,
  roleNote,
  notReachedLine,
  unsentLine,
  rolePanesSummary,
  livenessLine,
  leadWarning,
  cardStatusNote,
  changeWhen,
  leadWaitingLine,
  livePane,
  olderRoleNote,
  roleStatus,
  liveRecipient,
  startDefinition,
  startSummary,
  taskPlaceholder,
  type PaneRole,
  type TeamNote,
} from "../team-view";
import { ErrorLine, useAsyncAction } from "./use-async-action";

/** One team in the teams window: its state, pane per role, recent messages. */
export function TeamCard({
  team,
  project,
  installed,
  presetNames,
  plays,
  waiting,
  onEdit,
  onChanged,
  onRestartPane,
}: {
  team: TeamSummary;
  project: ProjectConfig;
  /** Presets whose CLI is installed: a role can get a new session of one. */
  installed: PresetChoice[];
  /** Every preset's name by id, to name the pane playing a role. */
  presetNames: Record<string, string>;
  /** The role each pane of the project plays, in any team. */
  plays: Record<string, PaneRole>;
  waiting: WaitingPanes;
  onEdit: (definition: TeamDefinition) => void;
  onChanged: () => Promise<void>;
  /** Restarts a pane of this window as its tab menu's Restart terminal does: it asks first when that stops work, and
   *  the pane resumes with the role note. */
  onRestartPane?: (paneId: string) => Promise<void>;
}) {
  const { run, busy, error } = useAsyncAction();
  // Why a role's pane was not reached by the last Start or assignment, per role.
  const [notReached, setNotReached] = useState<Record<string, string>>({});
  // The line under the team: the last Start (re-read against the log) or the last Apply.
  const [note, setNote] = useState<{ start: TeamStartResult } | { apply: TeamNote } | null>(null);
  const act = async <T,>(work: () => Promise<T>) => {
    const result = await run(work);
    await onChanged();
    return result;
  };
  const [task, setTask] = useState("");
  // The role picked for the task; "" is the default recipient the placeholder names.
  const [taskTo, setTaskTo] = useState("");
  const upcoming = startDefinition(team);
  // A recipient the next Start no longer runs (its role left the project file) is shown as the default, and sent as none.
  const recipient = liveRecipient(upcoming, taskTo);
  const start = async () => {
    const result = await act(() => window.aya.teamStart(project.slug, team.name, task.trim() || undefined, task.trim() && recipient ? recipient : undefined));
    if (!result) return;
    setNotReached(Object.fromEntries(result.held.map((h) => [h.role, h.reason])));
    setNote({ start: result });
    if (result.started) {
      setTask("");
      setTaskTo("");
    }
  };
  // Per role, the pane picked but not applied yet: "" none, a pane id, or NEW_PANE_PREFIX + preset.
  // Sent as explicit targets, so a pane named like a preset id is still that pane.
  const [picks, setPicks] = useState<Record<string, string>>({});
  const definition = team.definition;
  const leadWarned = leadWarning(definition);
  const statusNote = cardStatusNote(team);
  const startNote = note && ("start" in note ? startSummary(note.start, team.log) : note.apply);
  const liveness = livenessLine(team.liveness);
  const leadWaiting = leadWaitingLine(team, waiting);
  const current = (role: string) => livePane(team, role, project.tabs) ?? "";
  const changes = Object.fromEntries(Object.entries(picks).filter(([role, value]) => value !== current(role)));
  const tabName = (id: string) => project.tabs.find((t) => t.id === id)?.name ?? id;
  const moves = pendingMoves(team.name, changes, plays, tabName);
  const paneName = (role: string) => {
    const tab = project.tabs.find((t) => t.id === team.assignments[role]);
    return tab ? (presetNames[tab.presetId] ?? tab.name) : null;
  };
  const apply = async () => {
    const applied = changes;
    // One call: main checks every pick before anything, a "No pane" included, changes.
    const result = await act(async () => {
      const given = Object.entries(changes).flatMap(([role, value]) =>
        value ? [{ role, target: value.startsWith(NEW_PANE_PREFIX) ? value : `${PANE_PREFIX}${value}` }] : [],
      );
      const release = Object.entries(changes).flatMap(([role, value]) => (value ? [] : [role]));
      return window.aya.teamOpenPanes(project.slug, team.name, given, release);
    });
    if (!result) return;
    // A pick made while this Apply ran is the user's next one: keep it.
    setPicks((prev) => Object.fromEntries(Object.entries(prev).filter(([role, value]) => applied[role] !== value)));
    setNotReached((prev) => ({ ...prev, ...Object.fromEntries(result.panes.flatMap((p) => (p.notReached ? [[p.role, p.notReached]] : []))) }));
    if (result.panes.length) setNote({ apply: rolePanesSummary(result, team.running) });
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
                  placeholder={taskPlaceholder(upcoming, taskTo)}
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                />
                <select
                  className="aya-modal-input aya-teams-task-to"
                  aria-label={`Task goes to for ${team.name}`}
                  value={recipient}
                  onChange={(e) => setTaskTo(e.target.value)}
                >
                  <option value="">{upcoming?.lead ? "lead" : "first role"}</option>
                  {upcoming?.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}
                    </option>
                  ))}
                </select>
                <button className="aya-modal-btn aya-modal-btn--primary" disabled={busy} onClick={start}>
                  Start
                </button>
              </>
            )}
          </>
        )}
      </div>
      {([[leadWaiting, "lead waiting"], [liveness, "status"]] as const).map(
        ([line, label]) =>
          line && (
            <div key={label} className={`aya-teams-status aya-teams-status--${line.tone}`} aria-label={`${team.name} ${label}`}>
              {line.text}
            </div>
          ),
      )}
      <ErrorLine error={error ?? team.error} />
      {leadWarned && <div className="aya-teams-warning">{leadWarned}</div>}
      {startNote && (
        <div className={startNote.kind === "error" ? "aya-teams-warning" : "aya-teams-note"} aria-label={`${team.name} note`}>
          {startNote.text}
        </div>
      )}
      {statusNote && (
        <div className={`aya-teams-${statusNote.tone}`} aria-label={`${team.name} status command`}>
          {statusNote.text}
        </div>
      )}
      {team.repoChanged && (
        <div className="aya-teams-warning">
          The team changed in the project. {changeWhen(team.running)} runs the new version.
        </div>
      )}
      {team.repoGone && (
        <div className="aya-teams-warning">
          The team is no longer in the project, so it keeps its last version. Remove the team to forget it.
          <button className="aya-modal-btn" disabled={busy} onClick={() => act(() => window.aya.teamRemove(project.slug, team.name))}>
            Remove team
          </button>
        </div>
      )}
      {team.staleNotes.length > 0 && (
        <div className="aya-teams-role-alert" role="status" aria-label="stale role notes">
          {team.staleNotes.map((line) => (
            <div key={line}>⚠ {line}</div>
          ))}
        </div>
      )}
      {definition && (
        <div className="aya-teams-roles">
          {definition.roles.map((role) => {
            const status = roleStatus(team, role.id, project.tabs, waiting);
            const note = roleNote(team, role.id, project.tabs);
            const roleNoteStatus = team.roleNotes[role.id];
            const notReachedNow = notReachedLine(team, role.id, project.tabs, notReached[role.id]);
            const unsent = unsentLine(team, role.id);
            return (
              <div key={role.id} className="aya-teams-role-row">
                <div>
                  <div className="aya-teams-role-name">
                    <strong>{role.id}</strong>
                    {definition.lead === role.id && <span className="aya-teams-muted" aria-label={`${role.id} leads`}>leads</span>}
                    <span className={`aya-teams-status aya-teams-status--${status.tone}`} aria-label={`${role.id} status`}>
                      {status.text}
                    </span>
                  </div>
                  <div className="aya-teams-mustnot">
                    <span className="aya-teams-label">Must not</span> {role.mustNot}
                  </div>
                  {roleNoteStatus && (
                    <div className={roleNoteStatus.severity === "action" ? "aya-teams-role-alert" : "aya-teams-note"} role="status" aria-label={`${role.id} role note`}>
                      {roleNoteStatus.severity === "action" && <>⚠ </>}{roleNoteStatus.text}
                      {roleNoteStatus.severity === "action" && onRestartPane && team.restartable.includes(role.id) && project.tabs.some((t) => t.id === team.assignments[role.id]) && (
                        <>
                          {" "}
                          <button
                            className="aya-modal-btn"
                            type="button"
                            disabled={busy}
                            aria-label={`Restart ${role.id}'s pane`}
                            onClick={() => void act(() => onRestartPane(team.assignments[role.id]))}
                          >
                            Restart
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {team.olderRoles?.[role.id] && (
                    <div className="aya-teams-note" role="status" aria-label={`${role.id} older role`}>
                      {olderRoleNote(team.olderRoles[role.id])}
                    </div>
                  )}
                  {note && (
                    <div className="aya-teams-mustnot" aria-label={`${role.id} launch note`}>
                      {note}
                    </div>
                  )}
                  {unsent && (
                    <div className="aya-teams-role-alert" role="status" aria-label={`${role.id} unsent`}>
                      ⚠ {unsent}
                    </div>
                  )}
                  {notReachedNow && (
                    <div className="aya-teams-role-alert" role="status" aria-label={`${role.id} not reached`}>
                      ⚠ Not reached: {notReachedNow}
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
      {team.log.length > 0 && <TeamChat team={team.name} log={team.log} roles={definition?.roles.map((r) => r.id) ?? []} pane={paneName} />}
      {definition && Object.keys(team.assignments).length === 0 && (
        <div className="aya-modal-hint">Give each role a pane, then Start.</div>
      )}
    </div>
  );
}
