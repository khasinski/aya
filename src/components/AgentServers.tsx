// Pane header badge for the local servers a pane's agent started ("2 servers"), opening a list with each server's
// command, pid and ports, an Open link per port and a Stop button. Main does the finding and the stopping
// (electron/agent-servers.ts); this only polls while the pane is shown, and faster while something can change. Polls
// are aligned to the clock, so every pane's falls in one batch in main (one ps and one lsof).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentServer } from "../../shared/ipc-types";
import { pollVisible } from "../poll-visible";

/** While the agent works or a server is listed, a new or stopped server shows within this. */
export const SERVERS_FAST_POLL_MS = 4_000;
/** Otherwise: a server started by hand in an idle pane. */
export const SERVERS_SLOW_POLL_MS = 15_000;

export function serversLabel(count: number): string {
  return `${count} ${count === 1 ? "server" : "servers"}`;
}

function sameServers(a: AgentServer[], b: AgentServer[]): boolean {
  return a.length === b.length && a.every((s, i) => s.pid === b[i].pid && s.command === b[i].command && s.ports.join() === b[i].ports.join());
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export function AgentServers({ list, stop, open, active, busy = false }: {
  list: () => Promise<AgentServer[]>;
  stop: (pid: number) => Promise<unknown>;
  open: (port: number) => Promise<unknown>;
  /** The pane is shown and has a process to look under. */
  active: boolean;
  busy?: boolean;
}) {
  const [servers, setServers] = useState<AgentServer[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState<number[]>([]);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const calls = useRef({ list, stop, open });
  calls.current = { list, stop, open };
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const at = generation.current;
    try {
      const next = await calls.current.list();
      if (at === generation.current) setServers((old) => (sameServers(old, next) ? old : next));
    } catch { /* keep what was listed; the next poll tries again */ }
  }, []);
  const fast = busy || servers.length > 0;
  useEffect(() => {
    if (!active) { generation.current++; setServers([]); return; }
    return pollVisible(() => void refresh(), fast ? SERVERS_FAST_POLL_MS : SERVERS_SLOW_POLL_MS, { aligned: true });
  }, [active, fast, refresh]);
  useEffect(() => { if (!servers.length) setExpanded(false); }, [servers.length]);
  useEffect(() => {
    if (!expanded) { setError(""); return; }
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !button.current?.contains(target)) setExpanded(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [expanded]);
  if (!servers.length) return null;
  const rect = expanded ? button.current?.getBoundingClientRect() : undefined;
  const stopServer = async (pid: number) => {
    setStopping((old) => [...old, pid]);
    setError("");
    try { await calls.current.stop(pid); }
    catch (e) { setError(message(e)); }
    finally { setStopping((old) => old.filter((p) => p !== pid)); void refresh(); }
  };
  return <>
    <button ref={button} type="button" className="aya-servers-button" aria-expanded={expanded} aria-haspopup="dialog"
      title="Local servers this pane's agent started" onClick={() => setExpanded(!expanded)}>
      <span className="aya-servers-dot" aria-hidden="true" />{serversLabel(servers.length)}
    </button>
    {expanded && createPortal(
      <div ref={popover} className="aya-servers-popover" role="dialog" aria-label="Local servers"
        style={rect ? { top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setExpanded(false); button.current?.focus(); } }}>
        <div className="aya-servers-title">Local servers</div>
        <ul>
          {servers.map((server) => (
            <li key={server.pid} className="aya-servers-row" data-pid={server.pid}>
              <code className="aya-servers-command" title={server.command}>{server.command || "(unknown command)"}</code>
              <div className="aya-servers-meta">
                <span>pid {server.pid}</span>
                {server.ports.map((port) => (
                  <button key={port} type="button" className="aya-servers-open" title={`Open http://localhost:${port}`}
                    onClick={() => void calls.current.open(port).catch((e) => setError(message(e)))}>
                    Open :{port}
                  </button>
                ))}
                <button type="button" className="aya-servers-stop" disabled={stopping.includes(server.pid)}
                  aria-label={`Stop ${server.command || `process ${server.pid}`}`} onClick={() => void stopServer(server.pid)}>
                  {stopping.includes(server.pid) ? "Stopping…" : "Stop"}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {error && <div className="aya-servers-error" role="alert">{error}</div>}
      </div>,
      document.body,
    )}
  </>;
}
