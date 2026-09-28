import { useState } from "react";
import { flowEdges, flowGaps, flowKey, flowLayout, type FlowEdge } from "../team-flow";
import type { AyaIntelligenceConfig, FlowPreview, TeamDefinition } from "../types";
import { ipcMessage } from "./ipc-message";

const WIDTH = 340;
const HEIGHT = 220;
const NODE_H = 22;

function nodeWidth(id: string): number {
  return Math.max(48, id.length * 7 + 16);
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

function FlowGraph({ ids, edges, unlisted }: { ids: string[]; edges: FlowEdge[]; unlisted: FlowEdge[] }) {
  const at = flowLayout(ids, WIDTH, HEIGHT);
  const has = new Set([...edges, ...unlisted].map((e) => `${e.from}>${e.to}`));
  const line = (e: FlowEdge, dashed: boolean) => {
    const s = segment(at[e.from], at[e.to], has.has(`${e.to}>${e.from}`), e.from, e.to);
    return (
      <line
        key={`${e.from}>${e.to}`}
        {...s}
        className={dashed ? "aya-flow-edge aya-flow-edge--unlisted" : "aya-flow-edge"}
        markerEnd={dashed ? "url(#aya-flow-arrow-warn)" : "url(#aya-flow-arrow)"}
      />
    );
  };
  const label = edges.map((e) => `${e.from} to ${e.to}`).join(", ") || "no routes";
  return (
    <svg className="aya-flow-graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Team flow: ${label}`}>
      <defs>
        {["aya-flow-arrow", "aya-flow-arrow-warn"].map((id) => (
          <marker key={id} id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className={id === "aya-flow-arrow" ? "aya-flow-head" : "aya-flow-head aya-flow-head--unlisted"} />
          </marker>
        ))}
      </defs>
      {edges.map((e) => line(e, false))}
      {unlisted.map((e) => line(e, true))}
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

/** The routes the checkboxes allow, drawn live; ✨ adds what the text sends
 *  along each, and routes the text describes that are not ticked. */
export function TeamFlow({ team, intelligence }: { team: TeamDefinition; intelligence: AyaIntelligenceConfig }) {
  const [explained, setExplained] = useState<{ key: string; preview: FlowPreview } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = team.roles.map((r) => r.id).filter(Boolean);
  const edges = flowEdges(team.roles);
  const gaps = ids.length > 1 ? flowGaps(team.roles) : { unreached: [], silent: [] };
  const fresh = explained && explained.key === flowKey(team) ? explained.preview : null;
  const says = new Map(fresh?.routes.map((r) => [`${r.from}>${r.to}`, r.carries]) ?? []);

  return (
    <section className="aya-teams-flow" aria-label="Flow preview">
      <div className="aya-teams-role-head">
        <span className="aya-teams-muted">Flow preview</span>
        <span className="aya-teams-spacer" />
        <button
          className="aya-modal-btn"
          aria-label="Explain flow"
          title="Ask Aya Intelligence what your text sends along each route; edit the text if it reads it wrong"
          disabled={running || edges.length === 0}
          onClick={async () => {
            setError(null);
            setRunning(true);
            const key = flowKey(team);
            try {
              setExplained({ key, preview: await window.aya.teamPreviewFlow(team, intelligence) });
            } catch (err) {
              setError(ipcMessage(err));
            } finally {
              setRunning(false);
            }
          }}
        >
          {running ? "Reading… (up to a minute)" : "✨ Explain flow"}
        </button>
      </div>
      {ids.length > 1 && <FlowGraph ids={ids} edges={edges} unlisted={fresh?.unlisted ?? []} />}
      <ul className="aya-flow-routes" aria-label="Flow routes">
        {edges.length === 0 && <li className="aya-teams-muted">No routes: tick Sends to under a role.</li>}
        {edges.map((e) => {
          const carries = says.get(`${e.from}>${e.to}`);
          return (
            <li key={`${e.from}>${e.to}`}>
              <strong>{e.from}</strong> → <strong>{e.to}</strong>
              {fresh && (carries ? `: ${carries}` : <span className="aya-teams-muted">: not described in the text</span>)}
            </li>
          );
        })}
      </ul>
      {gaps.unreached.map((id) => (
        <div key={`to-${id}`} className="aya-teams-warning">
          Nobody sends to {id}
          {team.cadence?.role === id ? "; it only gets Aya's rounds" : "; it will never hear from the team"}.
        </div>
      ))}
      {gaps.silent.map((id) => (
        <div key={`from-${id}`} className="aya-teams-warning">
          {id} sends to nobody, so its work reaches no one.
        </div>
      ))}
      {fresh?.unlisted.map((e) => (
        <div key={`${e.from}>${e.to}`} className="aya-teams-warning">
          The text has {e.from} → {e.to} ({e.carries}), but {e.from} does not send to {e.to}. Tick it, or change the text.
        </div>
      ))}
      {explained && !fresh && <div className="aya-teams-muted">Edited since the explanation; explain again.</div>}
      {error && <div className="aya-teams-error">{error}</div>}
    </section>
  );
}
