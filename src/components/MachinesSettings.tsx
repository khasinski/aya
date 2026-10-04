import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { KnownHost, MachineStatus, MachineView } from "../types";
import {
  cpuText,
  foundText,
  gpuText,
  memoryText,
  modelLines,
  occupancyText,
  ollamaText,
  stateLine,
  suggestions,
} from "../machines-view";

const DEFAULT_OLLAMA_PORT = 11434;

const message = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

function Dot({ ok }: { ok: boolean }) {
  return <span className={`aya-machine-dot ${ok ? "aya-machine-dot--ok" : "aya-machine-dot--down"}`} aria-hidden="true" />;
}

function MachineCard({
  machine,
  onChanged,
  onRemoved,
}: {
  machine: MachineView;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const [status, setStatus] = useState<MachineStatus>(machine.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [purpose, setPurpose] = useState("");
  const purposeRef = useRef<HTMLInputElement>(null);
  const markRef = useRef<HTMLButtonElement>(null);
  const base = `machine-${machine.id}`;
  const port = machine.ollama.port;
  const now = new Date();

  useEffect(() => setStatus(machine.status), [machine.status]);
  useEffect(() => {
    if (marking) purposeRef.current?.focus();
  }, [marking]);

  const run = async (what: string, action: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(`${what} failed: ${message(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const checkNow = () =>
    run("Check", async () => {
      setStatus(await window.aya.machinesCheck(machine.reach === "local" ? "local" : machine.reach.ssh, port));
    });
  const free = () => run("Free", async () => {
    await window.aya.machinesCommand(["free", machine.id]);
    await onChanged();
  });
  const saveOccupancy = (e: FormEvent) => {
    e.preventDefault();
    if (!purpose.trim()) {
      setError("Mark in use failed: say what it is for.");
      purposeRef.current?.focus();
      return;
    }
    void run("Mark in use", async () => {
      await window.aya.machinesCommand(["occupy", machine.id, purpose.trim()]);
      setMarking(false);
      setPurpose("");
      await onChanged();
    });
  };
  const remove = () => {
    if (!window.confirm(`Remove ${machine.id} from Aya's machines? Aya stops reading its state; nothing changes on the machine.`)) return;
    void run("Remove", async () => {
      await window.aya.machinesCommand(["remove", machine.id]);
      onRemoved();
    });
  };

  const models = modelLines(status, now);
  return (
    <article className="aya-machine-card" aria-labelledby={`${base}-name`} data-testid="machine-card">
      <div className="aya-machine-card-head">
        <Dot ok={status.reachable} />
        <h4 id={`${base}-name`} className="aya-machine-name" tabIndex={-1}>
          {machine.label || machine.id}
        </h4>
        <span className="aya-machine-state" data-testid="machine-state">{stateLine(machine.reach, status)}</span>
        {machine.occupancy && (
          <span className="aya-machine-pill" data-testid="machine-occupancy">{occupancyText(machine.occupancy)}</span>
        )}
      </div>
      {status.reachable ? (
        <dl className="aya-machine-facts">
          <dt>GPU</dt>
          <dd>{gpuText(status)}</dd>
          <dt>CPU</dt>
          <dd>{cpuText(status)}</dd>
          <dt>Memory</dt>
          <dd>{memoryText(status)}</dd>
          <dt>Ollama</dt>
          <dd>{ollamaText(status, port)}</dd>
          {models.length > 0 && (
            <>
              <dt>Models</dt>
              <dd>
                <ul className="aya-machine-models">
                  {models.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="aya-machine-error">Why: {status.error}</p>
      )}
      {marking && (
        <form className="aya-machine-occupy" onSubmit={saveOccupancy}>
          <label className="aya-modal-label" htmlFor={`${base}-purpose`}>
            What is {machine.id} in use for?
          </label>
          <div className="aya-modal-input-row">
            <input
              id={`${base}-purpose`}
              ref={purposeRef}
              className="aya-modal-input"
              value={purpose}
              maxLength={200}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="run5 timed collection until 23:45"
              aria-describedby={error ? `${base}-error` : undefined}
              aria-invalid={error?.startsWith("Mark in use") ? true : undefined}
            />
            <button type="submit" className="aya-modal-btn aya-modal-btn--primary" disabled={busy !== null}>
              Save
            </button>
            <button
              type="button"
              className="aya-modal-btn"
              onClick={() => {
                setMarking(false);
                setError(null);
                markRef.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p id={`${base}-error`} className="aya-machine-error" role="alert">
          {error}
        </p>
      )}
      <div className="aya-machine-actions">
        {machine.occupancy ? (
          <button type="button" className="aya-modal-btn" onClick={() => void free()} disabled={busy !== null} aria-label={`Free ${machine.id}`}>
            Free
          </button>
        ) : (
          !marking && (
            <button
              ref={markRef}
              type="button"
              className="aya-modal-btn"
              onClick={() => setMarking(true)}
              disabled={busy !== null}
              aria-label={`Mark in use, ${machine.id}`}
            >
              Mark in use
            </button>
          )
        )}
        <button type="button" className="aya-modal-btn" onClick={() => void checkNow()} disabled={busy !== null} aria-label={`Check now, ${machine.id}`}>
          {busy === "Check" ? "Checking..." : "Check now"}
        </button>
        <button type="button" className="aya-modal-btn" onClick={remove} disabled={busy !== null} aria-label={`Remove ${machine.id}`}>
          Remove
        </button>
      </div>
    </article>
  );
}

export function MachinesSettings() {
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [hosts, setHosts] = useState<KnownHost[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, MachineStatus | "checking" | { failed: string }>>({});
  const [sentence, setSentence] = useState("");
  const [sentenceError, setSentenceError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [focusMachine, setFocusMachine] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [status, known] = await Promise.all([window.aya.machinesStatus(), window.aya.machinesHosts()]);
      setMachines(status.machines);
      setHosts(known);
    } catch (err) {
      setLoadError(message(err));
      setMachines((m) => m ?? []);
      setHosts((h) => h ?? []);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!focusMachine || !machines) return;
    const heading = document.getElementById(`machine-${focusMachine}-name`);
    if (heading) {
      heading.focus();
      setFocusMachine(null);
    }
  }, [focusMachine, machines]);

  const check = async (target: string) => {
    setChecks((c) => ({ ...c, [target]: "checking" }));
    try {
      const status = await window.aya.machinesCheck(target);
      setChecks((c) => ({ ...c, [target]: status }));
    } catch (err) {
      setChecks((c) => ({ ...c, [target]: { failed: message(err) } }));
    }
  };

  /** The CLI's own add: Aya's native Add / Cancel dialog decides; nothing is saved without the user's Add. */
  const add = async (argv: string[], key: string) => {
    setAdding(key);
    setAnswer(null);
    try {
      const before = new Set((machines ?? []).map((m) => m.id));
      const output = await window.aya.machinesCommand(argv);
      setAnswer(output.trim());
      await reload();
      const added = /^added (\S+)/m.exec(output)?.[1];
      if (added && !before.has(added)) setFocusMachine(added);
    } catch (err) {
      setAnswer(`Not added: ${message(err)}`);
    } finally {
      setAdding(null);
    }
  };

  const find = (e: FormEvent) => {
    e.preventDefault();
    if (!sentence.trim()) {
      setSentenceError("Write which machines to add, for example: athena is my 4090 box, and this machine.");
      return;
    }
    setSentenceError(null);
    void add(["add", sentence.trim()], "sentence");
  };

  const suggested = machines && hosts ? suggestions(hosts, machines) : [];
  const now = new Date();

  return (
    <section className="aya-settings-pane aya-machines" role="tabpanel" id="settings-panel-machines" aria-labelledby="settings-tab-machines">
      <div className="aya-settings-header">
        <div className="aya-settings-header-icon">
          <span className="aya-settings-material" style={{ fontFamily: "Material Symbols Outlined" }} aria-hidden="true">
            dns
          </span>
        </div>
        <div>
          <h2 className="aya-modal-title" ref={headingRef} tabIndex={-1}>
            Machines
          </h2>
          <p className="aya-modal-hint">Your own machines with Ollama. Aya reads their state over ssh; it never loads or unloads a model.</p>
        </div>
      </div>

      {loadError && (
        <p className="aya-machine-error" role="alert">
          Could not read the machines: {loadError}
        </p>
      )}
      {machines === null && <p className="aya-modal-hint" role="status">Checking the added machines...</p>}

      {machines && machines.length > 0 && (
        <>
          <h3 className="aya-machines-heading">Added</h3>
          <ul className="aya-machines-list">
            {machines.map((m) => (
              <li key={m.id}>
                <MachineCard
                  machine={m}
                  onChanged={reload}
                  onRemoved={() => {
                    headingRef.current?.focus();
                    void reload();
                  }}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <form className="aya-machines-find" onSubmit={find} noValidate>
        <label className="aya-modal-label" htmlFor="machines-sentence">
          Add machines in one sentence
        </label>
        <div className="aya-modal-input-row">
          <input
            id="machines-sentence"
            className="aya-modal-input"
            value={sentence}
            onChange={(e) => setSentence(e.target.value)}
            placeholder="athena is my 4090 box, and this machine"
            aria-describedby={sentenceError ? "machines-sentence-hint machines-sentence-error" : "machines-sentence-hint"}
            aria-invalid={sentenceError ? true : undefined}
            spellCheck={false}
          />
          <button type="submit" className="aya-modal-btn aya-modal-btn--primary" disabled={adding !== null}>
            {adding === "sentence" ? "Finding..." : "Find"}
          </button>
        </div>
        <p id="machines-sentence-hint" className="aya-modal-hint">
          Name ssh hosts, user@host or "this machine". Aya checks them read-only and asks you before it adds any.
        </p>
        {sentenceError && (
          <p id="machines-sentence-error" className="aya-machine-error" role="alert">
            {sentenceError}
          </p>
        )}
      </form>
      <div role="status" aria-live="polite">
        {answer && <pre className="aya-machines-answer" data-testid="machines-answer">{answer}</pre>}
      </div>

      <div className="aya-machines-suggested-head">
        <h3 className="aya-machines-heading">Suggested</h3>
        {suggested.length > 0 && (
          <button type="button" className="aya-modal-btn" onClick={() => suggested.forEach((s) => void check(s.target))}>
            Check all
          </button>
        )}
      </div>
      <p className="aya-modal-hint">
        Hosts from ~/.ssh/config, remote projects and this machine. Aya connects only to the ones you check.
      </p>
      {hosts === null ? (
        <p className="aya-modal-hint" role="status">Reading known hosts...</p>
      ) : suggested.length === 0 ? (
        <p className="aya-modal-hint">No other known hosts.</p>
      ) : (
        <ul className="aya-machines-list">
          {suggested.map((s) => {
            const result = checks[s.target];
            const status = result && result !== "checking" && !("failed" in result) ? result : null;
            const label = s.target === "local" ? "this machine" : s.target;
            return (
              <li key={s.target} className="aya-machine-suggestion" data-testid="machine-suggestion">
                <div className="aya-machine-suggestion-head">
                  <span className="aya-machine-target">{s.label}</span>
                  <span className="aya-machine-sources">{s.sources}</span>
                  <span className="aya-machine-actions">
                    <button type="button" className="aya-modal-btn" onClick={() => void check(s.target)} disabled={result === "checking"} aria-label={`Check ${label}`}>
                      {result === "checking" ? "Checking..." : "Check"}
                    </button>
                    <button
                      type="button"
                      className="aya-modal-btn"
                      onClick={() => void add(s.target === "local" ? ["add", "--local"] : ["add", "--ssh", s.target], s.target)}
                      disabled={adding !== null}
                      aria-label={`Add ${label}`}
                    >
                      {adding === s.target ? "Adding..." : "Add"}
                    </button>
                  </span>
                </div>
                <div role="status" aria-live="polite">
                  {status && (
                    <p className="aya-machine-found" data-testid="machine-found">
                      <Dot ok={status.reachable} />
                      {foundText(status, DEFAULT_OLLAMA_PORT, now)}
                    </p>
                  )}
                  {result && result !== "checking" && "failed" in result && (
                    <p className="aya-machine-error">Check failed: {result.failed}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
