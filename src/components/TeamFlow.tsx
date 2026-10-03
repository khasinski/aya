import { flowEdges, flowGaps, flowLayout, type FlowEdge } from "../team-flow";
import type { TeamDefinition } from "../types";

const WIDTH = 340;
const HEIGHT = 220;
const NODE_H = 22;
// A role's box fits its label: about NODE_CHAR_W px per character plus padding.
const NODE_MIN_W = 48;
const NODE_CHAR_W = 7;
const NODE_PAD_X = 16;

const edgeKey = (from: string, to: string) => `${from}>${to}`;

function nodeWidth(id: string): number {
  return Math.max(NODE_MIN_W, id.length * NODE_CHAR_W + NODE_PAD_X);
}

/** From the edge of one role's box to the other's; a two-way pair is split. */
function segment(a: { x: number; y: number }, b: { x: number; y: number }, twoWay: boolean, from: string, to: string) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const [ux, uy] = [dx / len, dy / len];
  const shift = twoWay ? 5 : 0;
  // Stop at the box: the ray leaves a w x h box after min(w/2/|ux|, h/2/|uy|).
  const exit = (w: number) => Math.min(w / 2 / Math.max(Math.abs(ux), 1e-6), NODE_H / 2 / Math.max(Math.abs(uy), 1e-6)) + 3;
  const start = exit(nodeWidth(from));
  const end = exit(nodeWidth(to)) + 4;
  return {
    x1: a.x + ux * start - uy * shift,
    y1: a.y + uy * start + ux * shift,
    x2: b.x - ux * end - uy * shift,
    y2: b.y - uy * end + ux * shift,
  };
}

function FlowGraph({ ids, edges }: { ids: string[]; edges: FlowEdge[] }) {
  const at = flowLayout(ids, WIDTH, HEIGHT);
  const has = new Set(edges.map((e) => edgeKey(e.from, e.to)));
  const label = edges.map((e) => `${e.from} to ${e.to}`).join(", ") || "no routes";
  return (
    <svg className="aya-flow-graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Team flow: ${label}`}>
      <defs>
        <marker id="aya-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="aya-flow-head" />
        </marker>
      </defs>
      {edges.map((e) => (
        <line
          key={edgeKey(e.from, e.to)}
          {...segment(at[e.from], at[e.to], has.has(edgeKey(e.to, e.from)), e.from, e.to)}
          className={e.what ? "aya-flow-edge" : "aya-flow-edge aya-flow-edge--unsaid"}
          markerEnd="url(#aya-flow-arrow)"
        />
      ))}
      {ids.map((id) => (
        <g key={id} transform={`translate(${at[id].x}, ${at[id].y})`}>
          <rect className="aya-flow-node" x={-nodeWidth(id) / 2} y={-NODE_H / 2} width={nodeWidth(id)} height={NODE_H} rx={6} />
          <text className="aya-flow-node-label" textAnchor="middle" dominantBaseline="central">
            {id}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** The routes the Sends to boxes allow, drawn live with what each carries,
 *  and what is missing. */
export function TeamFlow({ team }: { team: TeamDefinition }) {
  const ids = team.roles.map((r) => r.id).filter(Boolean);
  const edges = flowEdges(team.roles);
  const gaps = ids.length > 1 ? flowGaps(team.roles) : { unreached: [], silent: [] };

  return (
    <section className="aya-teams-flow" aria-label="Flow preview">
      <span className="aya-teams-muted">Flow preview</span>
      {ids.length > 1 && <FlowGraph ids={ids} edges={edges} />}
      <ul className="aya-flow-routes" aria-label="Flow routes">
        {edges.length === 0 && <li className="aya-teams-muted">No routes: tick Sends to under a role.</li>}
        {edges.map((e) => (
          <li key={edgeKey(e.from, e.to)}>
            <strong>{e.from}</strong> → <strong>{e.to}</strong>
            {e.what ? `: ${e.what}` : <span className="aya-teams-muted">: what it sends is not filled in</span>}
          </li>
        ))}
      </ul>
      {gaps.unreached.map((id) => (
        <div key={`to-${id}`} className="aya-teams-warning">
          Nobody sends to {id}
          {team.cadenceMinutes !== null && team.lead === id ? "; it only gets Aya's rounds" : "; it will never hear from the team"}.
        </div>
      ))}
      {gaps.silent.map((id) => (
        <div key={`from-${id}`} className="aya-teams-warning">
          {id} sends to nobody, so its work reaches no one.
        </div>
      ))}
    </section>
  );
}
