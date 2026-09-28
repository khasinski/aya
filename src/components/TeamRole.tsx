import type { PaneRole } from "../team-view";
import type { ProjectConfig, TeamSummary } from "../types";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";

/** "tester · ux-review" under a tab name, with the waiting-message count. */
export function TeamRoleChip({ role }: { role: PaneRole }) {
  return (
    <span className="aya-team-chip" title={`${role.role} in team ${role.team}`}>
      {role.role} · {role.team}
      {role.unread > 0 && (
        <span className="aya-team-unread" aria-label={`${role.unread} team messages waiting`}>
          ✉ {role.unread}
        </span>
      )}
    </span>
  );
}

/** Tab-menu entries: take a role of one of the project's teams, or drop it. */
export function TeamRoleMenuItems({
  paneId,
  teams,
  current,
  onAssign,
  onDone,
}: {
  paneId: string;
  teams: TeamSummary[];
  current: PaneRole | undefined;
  onAssign: (team: string, role: string, paneId: string | null) => void;
  onDone: () => void;
}) {
  const roles = teams.flatMap((t) => (t.definition ? t.definition.roles.map((r) => ({ team: t.name, role: r.id })) : []));
  if (roles.length === 0) return null;
  return (
    <>
      {roles.map(({ team, role }) => {
        const mine = current?.team === team && current.role === role;
        return (
          <button
            key={`${team}/${role}`}
            className="aya-context-menu-item"
            disabled={mine}
            onClick={() => {
              onAssign(team, role, paneId);
              onDone();
            }}
          >
            {mine ? "✓ " : ""}Team role: {team} › {role}
          </button>
        );
      })}
      {current && (
        <button
          className="aya-context-menu-item"
          onClick={() => {
            onAssign(current.team, current.role, null);
            onDone();
          }}
        >
          Remove team role
        </button>
      )}
    </>
  );
}

/** Offered once per team when a project with roles but no panes opens. */
export function TeamAssignPrompt({
  project,
  team,
  onOpenTeams,
  onDismiss,
}: {
  project: ProjectConfig;
  team: TeamSummary;
  onOpenTeams: () => void;
  onDismiss: () => void;
}) {
  const roles = team.definition?.roles.map((r) => r.id).join(", ") ?? "";
  return (
    <div className="aya-modal-backdrop" onMouseDown={markBackdropMouseDown} onClick={(e) => closeFromBackdropClick(e, onDismiss)}>
      <section
        className="aya-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Assign team roles"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aya-modal-title">Assign team roles?</div>
        <div className="aya-modal-hint">
          {project.name} defines the team {team.name} ({roles}) in .aya/teams/. No pane plays its roles yet.
        </div>
        <div className="aya-modal-actions">
          <button className="aya-modal-btn" onClick={onDismiss}>
            Not now
          </button>
          <button className="aya-modal-btn aya-modal-btn--primary" onClick={onOpenTeams}>
            Open teams
          </button>
        </div>
      </section>
    </div>
  );
}
