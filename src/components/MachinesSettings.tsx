// Settings > Machines: setup only. Add and remove machines here; their live state is the status bar's item.

import { useCallback, useEffect, useState } from "react";
import type { KnownHost, Machine } from "../types";
import { addAnswerText, MACHINES_CHANGED_EVENT, reachText } from "../machines-view";

export function MachinesSettings() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [hosts, setHosts] = useState<KnownHost[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const setup = await window.aya.machinesSetup();
      setMachines(setup.machines);
      setHosts(setup.hosts);
    } catch (err) {
      setAnswer((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (argv: string[]) => {
    setBusy(true);
    setAnswer(null);
    try {
      const output = await window.aya.machinesCommand(argv);
      if (argv[0] === "add") {
        setAnswer(addAnswerText(output));
        if (/^added /m.test(output)) setText("");
      }
      window.dispatchEvent(new Event(MACHINES_CHANGED_EVENT));
      await load();
    } catch (err) {
      setAnswer((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [
    ...(machines.some((m) => m.reach === "local") ? [] : [{ target: "local", label: "this machine" }]),
    ...hosts.filter((h) => !h.machine).map((h) => ({ target: h.target, label: h.target })),
  ];

  return (
    <div className="aya-machines-settings">
      {machines.length === 0 ? (
        <div className="aya-modal-hint">No machines yet. Add one below; Aya then shows it in the status bar.</div>
      ) : (
        <ul className="aya-machines-added" aria-label="Added machines">
          {machines.map((m) => (
            <li key={m.id} className="aya-machines-added-row">
              <strong>{m.id}</strong>
              <span className="aya-machines-muted">
                {reachText(m.reach)} · Ollama port {m.ollama.port}
              </span>
              <button className="aya-modal-btn" type="button" disabled={busy} onClick={() => void run(["remove", m.id])}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="aya-modal-input-row aya-machines-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void run(["add", text.trim()]);
        }}
      >
        <input
          className="aya-modal-input"
          aria-label="Machine to add"
          placeholder='An ssh alias, user@host or local; "port 11435" if not the default'
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="aya-modal-btn aya-modal-btn--primary" type="submit" disabled={busy || !text.trim()}>
          {busy ? "Adding..." : "Add"}
        </button>
      </form>
      {answer && (
        <div className="aya-modal-hint" role="status">
          {answer}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="aya-settings-suggested">
          <div className="aya-settings-section-title">From ~/.ssh/config and your remote projects</div>
          <div className="aya-settings-suggested-row">
            {suggestions.map((s) => (
              <button key={s.target} className="aya-settings-suggested-btn" type="button" disabled={busy} onClick={() => void run(["add", s.target])}>
                <span>Add {s.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
