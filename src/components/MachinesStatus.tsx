// The status bar's machines item: one icon, so six machines never fill the bar; its popover says what each has loaded
// and who claimed it. Hidden until a machine is added (Settings > Machines or `aya machines add`).

import { useCallback, useEffect, useRef, useState } from "react";
import type { MachineView } from "../types";
import { barLabel, claimText, clock, hardware, health, loadText, MACHINES_CHANGED_EVENT, modelLines, reachText } from "../machines-view";

/** Each poll probes every machine (over ssh for remote ones); half a minute keeps the bar current at little cost. */
const POLL_MS = 30_000;
const ICON_SIZE_SM_PX = 13;

export function MachinesStatus({ onManage }: { onManage: () => void }) {
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const lastAsked = useRef(0);

  const refresh = useCallback(async () => {
    // A slow probe that answers after a newer refresh (say, after a Remove) must not bring back the old list.
    const asked = ++lastAsked.current;
    try {
      const { machines } = await window.aya.machinesStatus();
      if (asked !== lastAsked.current) return;
      setMachines(machines);
      setError(null);
    } catch (err) {
      if (asked === lastAsked.current) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    // Only while Aya is on screen: a hidden window needs no ssh every half minute.
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener(MACHINES_CHANGED_EVENT, tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(MACHINES_CHANGED_EVENT, tick);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const onPointerDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, refresh]);

  const release = async (id: string) => {
    setReleasing(id);
    try {
      await window.aya.machinesCommand(["release", id]);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReleasing(null);
    }
  };

  if (machines.length === 0 && !error) return null;
  const now = new Date();
  const checked = machines.map((m) => m.status.checkedAt).sort()[0];

  return (
    <div className="aya-statusbar-popover-host" ref={hostRef}>
      <button
        data-testid="machines-toggle"
        className="aya-statusbar-item aya-statusbar-button"
        type="button"
        aria-label={error ? `Machines: ${error}` : barLabel(machines)}
        aria-expanded={open}
        title={error ? `Machines: ${error}` : barLabel(machines)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }} aria-hidden="true">
          dns
        </span>
      </button>
      {open && (
        <div className="aya-statusbar-popover aya-statusbar-popover--machines" role="dialog" aria-label="Machines">
          <div className="aya-statusbar-popover-title">
            <span>Machines{checked ? ` · checked ${clock(checked)}` : ""}</span>
            <button
              className="aya-statusbar-popover-action"
              type="button"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage
            </button>
          </div>
          {error && <div className="aya-statusbar-popover-empty aya-machines-error">{error}</div>}
          <ul className="aya-machines-list">
            {machines.map((m) => {
              const h = health(m.status);
              return (
                <li key={m.id} className="aya-machines-entry" data-testid="machine-entry">
                  <div className="aya-machines-entry-head">
                    <strong>{m.id}</strong>
                    <span className="aya-machines-muted">{hardware(m.status)}</span>
                    <span className={`aya-machines-state aya-machines-state--${h.level}`}>
                      <span className={`aya-machine-dot aya-machine-dot--${h.level}`} aria-hidden="true" />
                      {h.word}
                    </span>
                  </div>
                  <div className="aya-machines-muted">
                    {m.status.reachable ? `${loadText(m.status)} · ${reachText(m.reach)}` : `${reachText(m.reach)}: ${m.status.error}`}
                  </div>
                  {modelLines(m.status, m.ollama.port, now).map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                  {m.claim && (
                    <div className="aya-machines-claim">
                      <span>Claimed: {claimText(m.claim, now)}</span>
                      <button
                        className="aya-statusbar-popover-action"
                        type="button"
                        disabled={releasing === m.id}
                        onClick={() => void release(m.id)}
                      >
                        Release
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
