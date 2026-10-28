import type { PaneRole } from "../team-view";
import type { TeamSummary } from "../types";

/** "tester · ux-review" under a tab name, with the waiting-message count. */
export function TeamRoleChip({ role }: { role: PaneRole }) {
  return (
    <span className="aya-team-chip" title={`${role.role} in team ${role.team}`}>
      {role.role} · {role.team}
      <TeamUnread count={role.unread} label={`${role.unread} team messages waiting`} />
    </span>
  );
}

/** The "✉ 3" badge for team messages waiting; nothing at zero. */
export function TeamUnread({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="aya-team-unread" aria-label={label}>
      ✉ {count}
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
            type="button"
            role="menuitem"
            tabIndex={-1}
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
          type="button"
          role="menuitem"
          tabIndex={-1}
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
