// The team's message routes as the Sends to boxes define them, where to draw
// each role, and what is missing; no model involved.

import type { TeamRole } from "./types";

export type FlowEdge = { from: string; to: string; what: string };

export function flowEdges(roles: TeamRole[]): FlowEdge[] {
  const ids = new Set(roles.map((r) => r.id).filter(Boolean));
  const edges: FlowEdge[] = [];
  for (const role of roles) {
    if (!role.id) continue;
    for (const { to, what } of role.sendsTo) {
      if (to === role.id || !ids.has(to) || edges.some((e) => e.from === role.id && e.to === to)) continue;
      edges.push({ from: role.id, to, what: what.trim() });
    }
  }
  return edges;
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

/** Roles no route reaches, and roles with no route out. */
export function flowGaps(roles: TeamRole[]): { unreached: string[]; silent: string[] } {
  const edges = flowEdges(roles);
  const ids = roles.map((r) => r.id).filter(Boolean);
  return {
    unreached: ids.filter((id) => !edges.some((e) => e.to === id)),
    silent: ids.filter((id) => !edges.some((e) => e.from === id)),
  };
}
