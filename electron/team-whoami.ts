// What `aya team whoami` prints for a role. A Save compares it before and after: a role whose text changed is
// told to run whoami again, and its row says it works from an older role until it does.

import type { TeamDefinition, TeamRole } from "./types";
import type { TeamRunStatus } from "./team-records";
import { teamLiveGuidance } from "./team-live-guidance";

export function whoamiText(team: TeamDefinition, role: TeamRole, status?: TeamRunStatus): string {
  const sends = role.sendsTo.map((r) => (r.what ? `${r.to}: ${r.what}` : r.to));
  const lines = [
    `team      ${team.name}`,
    `you       ${role.id}`,
    ...(status ? teamLiveGuidance(team.name, status, role.id) : []),
    ...(sends.length ? sends.map((line, i) => `${i ? "         " : "sends to"}  ${line}`) : ["sends to  (nobody)"]),
    `must not  ${role.mustNot}`,
  ];
  if (team.lead === role.id) lines.push("", 'you lead this team: when the work is done or cannot go on, end it with: aya team pause "why"');
  lines.push("", 'give a role work with: aya team send <role> "text" (not aya team start). Start or resume only on the user\'s request; the role that paused a team can resume its own pause, but only the user can end a user pause.');
  lines.push("every role of the team, as it runs: aya team show");
  lines.push('wait on a teammate with: aya status waiting --on <role> "what you need" (plain aya status waiting asks the user)');
  if (role.responsibilities) lines.push("", role.responsibilities);
  if (team.protocol) lines.push("", "protocol", team.protocol);
  return `${lines.join("\n")}\n`;
}

/** Roles of `next` whose whoami differs from `before`'s (a role new in `next` counts); every role when `before` is null. */
export function rolesWhoseWhoamiChanged(before: TeamDefinition | null, next: TeamDefinition): string[] {
  return next.roles
    .filter((role) => {
      const was = before?.roles.find((r) => r.id === role.id);
      return !was || whoamiText(before!, was) !== whoamiText(next, role);
    })
    .map((r) => r.id);
}
