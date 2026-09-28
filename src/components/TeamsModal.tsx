import { useCallback, useEffect, useState } from "react";
import type { AyaIntelligenceConfig, ProjectConfig, TeamDefinition, TeamRole, TeamSummary } from "../types";
import { ipcMessage } from "./ipc-message";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";
import { TeamFlow } from "./TeamFlow";

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
  cadence: { role: "reviewer", minutes: 30 },
  protocol:
    "Findings are hypotheses with a measurement request, not facts. Number rounds and mark items [reported -> confirmed]. Reports are one-way unless a question is asked.",
};

/** What the team file accepts as a role id: typing "Senior UX" gives "senior-ux". */
function roleId(typed: string): string {
  return typed.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 40);
}

/** Renames a role and every send-to and cadence entry that pointed at it. */
function renameRole(team: TeamDefinition, index: number, id: string): TeamDefinition {
  const old = team.roles[index].id;
  const swap = (r: string) => (old && r === old ? id : r);
  return {
    ...team,
    roles: team.roles.map((r, i) =>
      i === index ? { ...r, id } : { ...r, sendsTo: r.sendsTo.map((s) => ({ ...s, to: swap(s.to) })) },
    ),
    cadence: team.cadence && { ...team.cadence, role: swap(team.cadence.role) },
  };
}

const EMPTY_ROLE: TeamRole = { id: "", sendsTo: [], mustNot: "", responsibilities: "" };

interface Props {
  project: ProjectConfig;
  intelligence: AyaIntelligenceConfig;
  onClose: () => void;
}

export function TeamsModal({ project, intelligence, onClose }: Props) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [editing, setEditing] = useState<{ team: TeamDefinition; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTeams(await window.aya.teamList(project.slug));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project.slug]);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await reload();
  };

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
              await window.aya.teamSave(project.slug, team);
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
            {error && <div className="aya-teams-error">{error}</div>}
            {teams.length === 0 && <div className="aya-modal-hint">No team yet.</div>}
            {teams.map((team) => (
              <TeamCard
                key={team.name}
                team={team}
                project={project}
                onEdit={(definition) => setEditing({ team: definition, isNew: false })}
                onAct={act}
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

function TeamCard({
  team,
  project,
  onEdit,
  onAct,
}: {
  team: TeamSummary;
  project: ProjectConfig;
  onEdit: (definition: TeamDefinition) => void;
  onAct: (work: () => Promise<unknown>) => Promise<void>;
}) {
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
          <button className="aya-modal-btn" onClick={() => onAct(() => window.aya.teamPause(project.slug, team.name))}>
            Pause
          </button>
        )}
        {definition && !team.running && (
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={() => onAct(() => window.aya.teamStart(project.slug, team.name))}
          >
            Start
          </button>
        )}
      </div>
      {team.error && <div className="aya-teams-error">{team.error}</div>}
      {team.repoChanged && (
        <div className="aya-teams-warning">
          The repo file changed since this team was saved. Aya keeps running the saved version.
          {team.repoDefinition && (
            <button
              className="aya-modal-btn"
              onClick={() => onAct(() => window.aya.teamSave(project.slug, team.repoDefinition as TeamDefinition))}
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
                <td className="aya-teams-muted">{role.sendsTo.length ? `sends to ${role.sendsTo.map((r) => r.to).join(", ")}` : ""}</td>
                <td>
                  <select
                    aria-label={`Pane for ${role.id}`}
                    value={team.assignments[role.id] ?? ""}
                    onChange={(e) =>
                      onAct(() =>
                        window.aya.teamAssign(project.slug, team.name, role.id, e.target.value || null),
                      )
                    }
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
                  {new Date(m.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} {m.from} →{" "}
                  {m.to}
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

function TeamEditor({
  initial,
  isNew,
  intelligence,
  onSave,
  onCancel,
}: {
  initial: TeamDefinition;
  isNew: boolean;
  intelligence: AyaIntelligenceConfig;
  onSave: (team: TeamDefinition) => Promise<void>;
  onCancel: () => void;
}) {
  const [team, setTeam] = useState<TeamDefinition>(initial);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [draftError, setDraftError] = useState<{ index: number; message: string } | null>(null);
  const setRole = (index: number, patch: Partial<TeamRole>) =>
    setTeam((t) => ({ ...t, roles: t.roles.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));

  return (
    <div className="aya-teams-editor">
      <div className="aya-modal-title">{isNew ? "Define team" : `Edit ${initial.name}`}</div>
      <label className="aya-teams-field">
        <span>Team name</span>
        <input
          className="aya-modal-input"
          aria-label="Team name"
          value={team.name}
          disabled={!isNew}
          placeholder="ux-review"
          onChange={(e) => setTeam({ ...team, name: e.target.value })}
        />
      </label>
      {team.roles.map((role, index) => (
        <div className="aya-teams-role" key={index}>
          <div className="aya-teams-role-head">
            <span className="aya-teams-muted">Role</span>
            <input
              className="aya-modal-input"
              aria-label={`Role ${index + 1} name`}
              placeholder="role"
              value={role.id}
              onChange={(e) => setTeam((t) => renameRole(t, index, roleId(e.target.value)))}
            />
            <button
              className="aya-modal-btn"
              aria-label={`Draft role ${index + 1}`}
              title="Draft this role from its name with Aya Intelligence; edit before saving"
              disabled={!role.id.trim() || drafting !== null}
              onClick={async () => {
                setDraftError(null);
                setDrafting(index);
                try {
                  const draft = await window.aya.teamDraftRole(
                    role.id.replace(/-/g, " "),
                    team.roles.map((r) => r.id.trim()).filter(Boolean),
                    role.sendsTo.map((r) => r.to),
                    team.roles.map(({ id, responsibilities, mustNot }) => ({ id, responsibilities, mustNot })),
                    intelligence,
                  );
                  // The draft picks the routes; a what typed for a route it keeps stays.
                  const typed = new Map(role.sendsTo.map((r) => [r.to, r.what]));
                  setRole(index, {
                    ...draft,
                    sendsTo: draft.sendsTo.map((r) => ({ to: r.to, what: r.what || typed.get(r.to) || "" })),
                  });
                } catch (err) {
                  setDraftError({ index, message: ipcMessage(err) });
                } finally {
                  setDrafting(null);
                }
              }}
            >
              {drafting === index ? "Drafting… (up to a minute)" : "✨ Draft"}
            </button>
            <button
              className="aya-modal-btn"
              aria-label={`Remove role ${index + 1}`}
              onClick={() => setTeam({ ...team, roles: team.roles.filter((_, i) => i !== index) })}
            >
              Remove
            </button>
          </div>
          {draftError?.index === index && <div className="aya-teams-error">{draftError.message}</div>}
          <span className="aya-teams-muted">Responsibilities</span>
          <textarea
            className="aya-modal-input"
            aria-label={`Role ${index + 1} responsibilities`}
            placeholder="Responsibilities"
            value={role.responsibilities}
            onChange={(e) => setRole(index, { responsibilities: e.target.value })}
          />
          <span className="aya-teams-muted">Must not</span>
          <input
            className="aya-modal-input"
            aria-label={`Role ${index + 1} must not`}
            placeholder="Must not (required)"
            value={role.mustNot}
            onChange={(e) => setRole(index, { mustNot: e.target.value })}
          />
          <div className="aya-teams-sends">
            <span className="aya-teams-muted">Sends to</span>
            {team.roles
              .filter((other, i) => i !== index && other.id)
              .map((other) => {
                const route = role.sendsTo.find((r) => r.to === other.id);
                return (
                  <div className="aya-teams-send" key={other.id}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Role ${index + 1} sends to ${other.id}`}
                        checked={Boolean(route)}
                        onChange={(e) =>
                          setRole(index, {
                            sendsTo: e.target.checked
                              ? [...role.sendsTo, { to: other.id, what: "" }]
                              : role.sendsTo.filter((r) => r.to !== other.id),
                          })
                        }
                      />
                      {other.id}
                    </label>
                    {route && (
                      <input
                        className="aya-modal-input"
                        aria-label={`What goes from role ${index + 1} to ${other.id}`}
                        placeholder="what it sends"
                        value={route.what}
                        onChange={(e) =>
                          setRole(index, {
                            sendsTo: role.sendsTo.map((r) =>
                              r.to === other.id ? { ...r, what: e.target.value.replace(/[()\n]/g, "") } : r,
                            ),
                          })
                        }
                      />
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      <button className="aya-modal-btn" onClick={() => setTeam({ ...team, roles: [...team.roles, { ...EMPTY_ROLE }] })}>
        Add role
      </button>
      <label className="aya-teams-field">
        <span>Rounds</span>
        <select
          aria-label="Round role"
          value={team.cadence?.role ?? ""}
          onChange={(e) =>
            setTeam({
              ...team,
              cadence: e.target.value ? { role: e.target.value, minutes: team.cadence?.minutes ?? 30 } : null,
            })
          }
        >
          <option value="">No rounds</option>
          {team.roles
            .filter((r) => r.id)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.id}
              </option>
            ))}
        </select>
        {team.cadence && (
          <>
            every
            <input
              className="aya-modal-input aya-teams-minutes"
              type="number"
              min={1}
              aria-label="Round minutes"
              value={team.cadence.minutes}
              onChange={(e) =>
                setTeam({ ...team, cadence: { ...(team.cadence as NonNullable<TeamDefinition["cadence"]>), minutes: Number(e.target.value) } })
              }
            />
            min
          </>
        )}
      </label>
      <textarea
        className="aya-modal-input"
        aria-label="Protocol"
        placeholder="Protocol: how the roles work together"
        value={team.protocol}
        onChange={(e) => setTeam({ ...team, protocol: e.target.value })}
      />
      <TeamFlow team={team} />
      {error && <div className="aya-teams-error">{error}</div>}
      <div className="aya-modal-actions">
        <button className="aya-modal-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="aya-modal-btn aya-modal-btn--primary"
          onClick={async () => {
            setError(null);
            try {
              await onSave(team);
            } catch (err) {
              setError(ipcMessage(err));
            }
          }}
        >
          Save team
        </button>
      </div>
    </div>
  );
}
