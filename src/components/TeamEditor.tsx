import { useState } from "react";
import {
  addRole,
  applyDraft,
  cadenceProblem,
  DEFAULT_CADENCE_MINUTES,
  fromEditor,
  leadProblem,
  removeRole,
  roleId,
  roleIdProblem,
  setCadence,
  setLead,
  setSend,
  toEditor,
  updateRole,
  type EditorRole,
  type EditorTeam,
} from "../team-edit";
import { MAX_CADENCE_MINUTES } from "../main-mirrors";
import type { AyaIntelligenceConfig, TeamDefinition } from "../types";
import { TeamFlow } from "./TeamFlow";
import { ErrorLine, useAsyncAction } from "./use-async-action";

/** Define team / Edit: roles, routes with what they carry, rounds, protocol. */
export function TeamEditor({
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
  const [team, setTeam] = useState<EditorTeam>(() => toEditor(initial));
  const [drafting, setDrafting] = useState<number | null>(null);
  const save = useAsyncAction();
  const built = fromEditor(team);
  const cadenceError = team.cadenceMinutes === null ? null : cadenceProblem(team.cadenceMinutes);
  const leadError = leadProblem(team);
  const invalid = Boolean(cadenceError) || leadError !== null || team.roles.some((r) => roleIdProblem(r.id));
  const draftRole = async (role: EditorRole) => {
    setDrafting(role.key);
    try {
      const draft = await window.aya.teamDraftRole(built, role.id, intelligence);
      setTeam((t) => applyDraft(t, role.key, draft));
    } finally {
      setDrafting(null);
    }
  };

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
        <RoleEditor
          key={role.key}
          role={role}
          index={index}
          team={team}
          setTeam={setTeam}
          drafting={drafting}
          onDraft={() => draftRole(role)}
        />
      ))}
      <button className="aya-modal-btn" onClick={() => setTeam(addRole(team))}>
        Add role
      </button>
      <label className="aya-teams-field">
        <span>Lead</span>
        <select
          aria-label="Lead role"
          value={team.lead === null ? "" : String(team.lead)}
          onChange={(e) => setTeam(setLead(team, e.target.value ? Number(e.target.value) : null))}
        >
          <option value="">Pick the lead</option>
          {team.roles
            .filter((r) => r.id)
            .map((r) => (
              <option key={r.key} value={String(r.key)}>
                {r.id}
              </option>
            ))}
        </select>
      </label>
      <ErrorLine error={leadError} />
      <label className="aya-teams-field">
        <span>Rounds</span>
        <select
          aria-label="Rounds"
          value={team.cadenceMinutes === null ? "" : "lead"}
          onChange={(e) => setTeam(setCadence(team, e.target.value ? DEFAULT_CADENCE_MINUTES : null))}
        >
          <option value="">No rounds</option>
          <option value="lead">To the lead</option>
        </select>
        {team.cadenceMinutes !== null && (
          <>
            every
            <input
              className="aya-modal-input aya-teams-minutes"
              type="number"
              min={1}
              max={MAX_CADENCE_MINUTES}
              aria-label="Round minutes"
              value={team.cadenceMinutes}
              onChange={(e) => setTeam(setCadence(team, Number(e.target.value)))}
            />
            min
          </>
        )}
      </label>
      <ErrorLine error={cadenceError} />
      <textarea
        className="aya-modal-input"
        aria-label="Protocol"
        placeholder="Protocol: how the roles work together"
        value={team.protocol}
        onChange={(e) => setTeam({ ...team, protocol: e.target.value })}
      />
      <TeamFlow team={built} />
      <ErrorLine error={save.error} />
      <div className="aya-modal-actions">
        <button className="aya-modal-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="aya-modal-btn aya-modal-btn--primary" disabled={save.busy || invalid} onClick={() => save.run(() => onSave(built))}>
          Save team
        </button>
      </div>
    </div>
  );
}

function RoleEditor({
  role,
  index,
  team,
  setTeam,
  drafting,
  onDraft,
}: {
  role: EditorRole;
  index: number;
  team: EditorTeam;
  setTeam: (update: (t: EditorTeam) => EditorTeam) => void;
  drafting: number | null;
  onDraft: () => Promise<void>;
}) {
  const draft = useAsyncAction();
  const n = index + 1;
  const update = (patch: Parameters<typeof updateRole>[2]) => setTeam((t) => updateRole(t, role.key, patch));
  return (
    <div className="aya-teams-role">
      <div className="aya-teams-role-head">
        <span className="aya-teams-muted">Role</span>
        <input
          className="aya-modal-input"
          aria-label={`Role ${n} name`}
          placeholder="role"
          value={role.id}
          onChange={(e) => update({ id: roleId(e.target.value) })}
        />
        <button
          className="aya-modal-btn"
          aria-label={`Draft role ${n}`}
          title="Draft this role from its name and the rest of the team with Aya Intelligence; edit before saving"
          disabled={!role.id || drafting !== null}
          onClick={() => draft.run(onDraft)}
        >
          {drafting === role.key ? "Drafting… (up to a minute)" : "✨ Draft"}
        </button>
        <button className="aya-modal-btn" aria-label={`Remove role ${n}`} onClick={() => setTeam((t) => removeRole(t, role.key))}>
          Remove
        </button>
      </div>
      <ErrorLine error={roleIdProblem(role.id)} />
      <ErrorLine error={draft.error} />
      <span className="aya-teams-muted">Responsibilities</span>
      <textarea
        className="aya-modal-input"
        aria-label={`Role ${n} responsibilities`}
        placeholder="Responsibilities"
        value={role.responsibilities}
        onChange={(e) => update({ responsibilities: e.target.value })}
      />
      <span className="aya-teams-muted">Must not</span>
      <input
        className="aya-modal-input"
        aria-label={`Role ${n} must not`}
        placeholder="Must not (required)"
        value={role.mustNot}
        onChange={(e) => update({ mustNot: e.target.value })}
      />
      <div className="aya-teams-sends">
        <span className="aya-teams-muted">Sends to</span>
        {team.roles
          .filter((other) => other.key !== role.key && other.id)
          .map((other) => {
            const route = role.sendsTo.find((s) => s.key === other.key);
            return (
              <div className="aya-teams-send" key={other.key}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Role ${n} sends to ${other.id}`}
                    checked={Boolean(route)}
                    onChange={(e) => setTeam((t) => setSend(t, role.key, other.key, e.target.checked))}
                  />
                  {other.id}
                </label>
                {route && (
                  <input
                    className="aya-modal-input"
                    aria-label={`What goes from role ${n} to ${other.id}`}
                    placeholder="what it sends"
                    value={route.what}
                    onChange={(e) => setTeam((t) => setSend(t, role.key, other.key, true, e.target.value))}
                  />
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
