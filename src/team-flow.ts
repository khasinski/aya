// The team's message routes as the Sends to checkboxes define them, and where
// to draw each role; no model involved.

import type { TeamDefinition, TeamRole } from "./types";

export type FlowEdge = { from: string; to: string };

export function flowEdges(roles: TeamRole[]): FlowEdge[] {
  const ids = new Set(roles.map((r) => r.id).filter(Boolean));
  const seen = new Set<string>();
  const edges: FlowEdge[] = [];
  for (const role of roles) {
    if (!role.id) continue;
    for (const to of role.sendsTo) {
      const key = `${role.id}>${to}`;
      if (to === role.id || !ids.has(to) || seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: role.id, to });
    }
  }
  return edges;
}

/** What the explanation was read from; it goes stale when this changes. */
export function flowKey(team: TeamDefinition): string {
  return JSON.stringify([team.roles.map((r) => [r.id, r.sendsTo, r.responsibilities, r.mustNot]), team.protocol]);
}

/** Roles on an ellipse, the first at the top, clockwise. */
export function flowLayout(ids: string[], width: number, height: number): Record<string, { x: number; y: number }> {
  const at: Record<string, { x: number; y: number }> = {};
  ids.forEach((id, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / ids.length;
    at[id] = { x: width / 2 + (width / 2 - 60) * Math.cos(angle), y: height / 2 + (height / 2 - 24) * Math.sin(angle) };
  });
  return at;
}

/** Roles no route reaches, and roles with no route out; drawn from the boxes. */
export function flowGaps(roles: TeamRole[]): { unreached: string[]; silent: string[] } {
  const edges = flowEdges(roles);
  const ids = roles.map((r) => r.id).filter(Boolean);
  return {
    unreached: ids.filter((id) => !edges.some((e) => e.to === id)),
    silent: ids.filter((id) => !edges.some((e) => e.from === id)),
  };
}
