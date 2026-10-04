import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { KnownHost, MachineStatus, MachineView } from "../types";
import {
  type Cell,
  cpuText,
  foundText,
  gpuCell,
  gpuText,
  health,
  historyText,
  keepOrder,
  lastCheckText,
  loadCell,
  memoryCell,
  memoryText,
  modelCell,
  modelLines,
  occupancyShort,
  occupancyText,
  ollamaText,
  savedText,
  stateLine,
  suggestions,
  usageText,
  vramCell,
} from "../machines-view";

const DEFAULT_OLLAMA_PORT = 11434;

type CheckResult = MachineStatus | "checking" | { failed: string };
type Suggestion = ReturnType<typeof suggestions>[number];

const message = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

function Dot({ level }: { level: "ok" | "warn" | "down" }) {
  return <span className={`aya-machine-dot aya-machine-dot--${level}`} aria-hidden="true" />;
}

/** A number with a thin bar under it; the number carries the value, the bar is decoration. */
function Meter({ cell }: { cell: Cell }) {
  return (
    <>
      <span className="aya-machine-num">{cell.text}</span>
      {cell.frac !== null && (
        <span className="aya-machine-bar" aria-hidden="true">
          <span style={{ width: `${Math.round(cell.frac * 100)}%` }} />
        </span>
      )}
    </>
  );
}

const domId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** A host's current usage and history. */
function HostHistory({ host, id }: { host: KnownHost; id: string }) {
  const now = new Date();
  const check = lastCheckText(host, now);
  return (
    <div className="aya-host-history">
      <p>{usageText(host)}</p>
      <p>{savedText(host, now)}</p>
      {check && <p>{check}</p>}
      {host.history?.length ? (
        <>
          <p id={`${id}-history`}>History, newest last:</p>
          <ul aria-labelledby={`${id}-history`}>
            {host.history.map((e, i) => (
              <li key={`${e.at}-${i}`}>{historyText(e, now)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>No history yet.</p>
      )}
    </div>
  );
}

const COLUMNS = 9;

/** One added machine: a table row with its numbers, a details row behind the name (a disclosure button) and a More disclosure with its actions. */
function MachineRow({
  machine,
  host,
  onChanged,
  onChecked,
  onRemoved,
}: {
  machine: MachineView;
  host?: KnownHost;
  onChanged: () => Promise<void>;
  onChecked: () => Promise<void>;
  onRemoved: () => void;
}) {
  const [status, setStatus] = useState<MachineStatus>(machine.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const purposeRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const base = `machine-${domId(machine.id)}`;
  const port = machine.ollama.port;
  const now = new Date();

  useEffect(() => setStatus(machine.status), [machine.status]);
  useEffect(() => {
    if (marking) purposeRef.current?.focus();
  }, [marking]);
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, [menu]);

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
  /** A menu item closes the menu and leaves focus on More, never on a removed button. */
  const pick = (action: () => void) => {
    setMenu(false);
    moreRef.current?.focus();
    action();
  };

  const checkNow = () =>
    run("Check", async () => {
      setStatus(await window.aya.machinesCheck(machine.reach === "local" ? "local" : machine.reach.ssh, port));
      await onChecked();
    });
  const free = () =>
    run("Mark free", async () => {
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
      moreRef.current?.focus();
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

  const h = health(status);
  const model = modelCell(status, now);
  const models = modelLines(status, now);
  const name = machine.label || machine.id;
  return (
    <tbody
      className={`aya-machine-group${open ? " aya-machine-group--open" : ""}`}
      data-testid="machine-row"
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (menu && !moreRef.current?.contains(to) && !menuRef.current?.contains(to)) setMenu(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && menu) {
          // The settings dialog closes on Escape too; this one only closes the actions.
          e.stopPropagation();
          setMenu(false);
          moreRef.current?.focus();
        }
      }}
    >
      <tr className="aya-machine-row">
        <th scope="row" className="aya-mcol-name">
          <button
            type="button"
            id={`${base}-name`}
            className="aya-machine-toggle"
            aria-expanded={open}
            aria-controls={`${base}-details`}
            aria-label={`${name} details`}
            onClick={() => setOpen((o) => !o)}
          >
            {name}
          </button>
        </th>
        <td className="aya-mcol-status" data-testid="machine-state">
          <Dot level={h.level} />
          {busy === "Check" ? "Checking..." : h.word}
        </td>
        {status.reachable ? (
          <>
            <td className="aya-mcol-num aya-mcol-gpu" data-testid="machine-gpu"><Meter cell={gpuCell(status)} /></td>
            <td className="aya-mcol-num" data-testid="machine-vram"><Meter cell={vramCell(status)} /></td>
            <td className="aya-mcol-num aya-mcol-cpu" data-testid="machine-load"><Meter cell={loadCell(status)} /></td>
            <td className="aya-mcol-num aya-mcol-mem" data-testid="machine-memory"><Meter cell={memoryCell(status)} /></td>
            <td className="aya-mcol-model" data-testid="machine-model" title={models.join("\n")}>
              <span className={`aya-machine-model-name${model.hot ? " aya-machine-model-name--loaded" : ""}`}>{model.name}</span>
              {model.hot && <span className="aya-machine-hot">{model.hot}</span>}
            </td>
          </>
        ) : (
          <td colSpan={5} className="aya-mcol-why" title={status.error ?? undefined}>
            Why: {status.error ?? "?"}
          </td>
        )}
        <td className="aya-mcol-use">
          {machine.occupancy ? (
            // The whole text is in the DOM (its accessible name); only the pill's box ellipsizes it.
            <span className="aya-machine-pill" data-testid="machine-occupancy" title={occupancyShort(machine.occupancy)}>
              {occupancyShort(machine.occupancy)}
            </span>
          ) : (
            <span className="aya-machine-muted">free</span>
          )}
        </td>
        <td className="aya-mcol-more">
          <button
            ref={moreRef}
            type="button"
            className="aya-modal-btn aya-machine-more-btn"
            aria-expanded={menu}
            aria-controls={`${base}-menu`}
            aria-label={`More, ${machine.id}`}
            onClick={() => setMenu((m) => !m)}
          >
            More
          </button>
        </td>
      </tr>
      {/* A row of its own under the machine, so the actions push the details down instead of covering them. */}
      <tr id={`${base}-menu`} className="aya-machine-sub aya-machine-actions-row" hidden={!menu}>
        <td colSpan={COLUMNS}>
          <div ref={menuRef} className="aya-machine-menu" role="group" aria-label={`Actions for ${machine.id}`}>
            <button type="button" onClick={() => pick(() => void checkNow())} disabled={busy !== null} aria-label={`Check now, ${machine.id}`}>
              Check now
            </button>
            {machine.occupancy ? (
              <button type="button" onClick={() => pick(() => void free())} disabled={busy !== null} aria-label={`Mark free, ${machine.id}`}>
                Mark free
              </button>
            ) : (
              <button type="button" onClick={() => pick(() => setMarking(true))} disabled={busy !== null || marking} aria-label={`Mark in use, ${machine.id}`}>
                Mark in use
              </button>
            )}
            <button type="button" className="aya-machine-menu-danger" onClick={() => pick(remove)} disabled={busy !== null} aria-label={`Remove ${machine.id}`}>
              Remove
            </button>
          </div>
        </td>
      </tr>
      {marking && (
        <tr className="aya-machine-sub">
          <td colSpan={COLUMNS}>
            <form className="aya-machine-occupy" onSubmit={saveOccupancy}>
              <label className="aya-machine-occupy-label" htmlFor={`${base}-purpose`}>
                What is {machine.id} in use for?
              </label>
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
              <button type="submit" className="aya-modal-btn aya-modal-btn--primary aya-machines-sm" disabled={busy !== null}>
                Save
              </button>
              <button
                type="button"
                className="aya-modal-btn aya-machines-sm"
                onClick={() => {
                  setMarking(false);
                  setError(null);
                  moreRef.current?.focus();
                }}
              >
                Cancel
              </button>
            </form>
          </td>
        </tr>
      )}
      {error && (
        <tr className="aya-machine-sub">
          <td colSpan={COLUMNS}>
            <p id={`${base}-error`} className="aya-machine-error" role="alert">
              {error}
            </p>
          </td>
        </tr>
      )}
      <tr id={`${base}-details`} className="aya-machine-sub aya-machine-details" hidden={!open} data-testid="machine-details">
        <td colSpan={COLUMNS}>
          <div className="aya-machine-details-grid">
            <dl className="aya-machine-facts">
              <dt>State</dt>
              <dd data-testid="machine-reach">{stateLine(machine.reach, status)}</dd>
              {status.reachable ? (
                <>
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
                </>
              ) : (
                <>
                  <dt>Why</dt>
                  <dd>{status.error}</dd>
                </>
              )}
              {machine.occupancy && (
                <>
                  <dt>In use</dt>
                  <dd>{occupancyText(machine.occupancy).replace(/^In use: /, "")}</dd>
                </>
              )}
            </dl>
            {host && <HostHistory host={host} id={`${base}-host`} />}
          </div>
        </td>
      </tr>
    </tbody>
  );
}

/** A suggested host: one compact row with Check and Add; its usage and history behind the name when Aya has seen it before. */
function SuggestionRow({
  s,
  result,
  adding,
  onCheck,
  onAdd,
}: {
  s: Suggestion;
  result: CheckResult | undefined;
  adding: string | null;
  onCheck: () => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const status = result && result !== "checking" && !("failed" in result) ? result : null;
  const label = s.target === "local" ? "this machine" : s.target;
  const id = `host-details-${domId(s.target)}`;
  return (
    <li className="aya-machine-suggestion" data-testid="machine-suggestion">
      <div className="aya-machine-suggestion-head">
        {s.host ? (
          <button
            type="button"
            className="aya-machine-toggle aya-machine-target"
            aria-expanded={open}
            aria-controls={id}
            aria-label={`${s.label} usage and history`}
            onClick={() => setOpen((o) => !o)}
          >
            {s.label}
          </button>
        ) : (
          <span className="aya-machine-target aya-machine-target--plain">{s.label}</span>
        )}
        <span className="aya-machine-sources">{s.sources}</span>
        <span className="aya-machine-actions">
          <button type="button" className="aya-modal-btn aya-machines-sm" onClick={onCheck} disabled={result === "checking"} aria-label={`Check ${label}`}>
            {result === "checking" ? "Checking..." : "Check"}
          </button>
          <button type="button" className="aya-modal-btn aya-machines-sm" onClick={onAdd} disabled={adding !== null} aria-label={`Add ${label}`}>
            {adding === s.target ? "Adding..." : "Add"}
          </button>
        </span>
      </div>
      <div role="status" aria-live="polite">
        {status && (
          <p className="aya-machine-found" data-testid="machine-found">
            <Dot level={status.reachable ? "ok" : "down"} />
            {foundText(status, DEFAULT_OLLAMA_PORT, new Date())}
          </p>
        )}
        {result && result !== "checking" && "failed" in result && <p className="aya-machine-error">Check failed: {result.failed}</p>}
      </div>
      {s.host && (
        <div id={id} hidden={!open} className="aya-host-details-body" data-testid="host-details">
          <HostHistory host={s.host} id={id} />
        </div>
      )}
    </li>
  );
}

export function MachinesSettings() {
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [hosts, setHosts] = useState<KnownHost[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const [sentence, setSentence] = useState("");
  const [sentenceError, setSentenceError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);
  const [showSuggested, setShowSuggested] = useState(true);
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

  /** After a Check: the rows show its result and history where they are. */
  const refreshHosts = useCallback(async () => {
    const fresh = await window.aya.machinesHosts().catch(() => null);
    if (fresh) setHosts((shown) => keepOrder(shown, fresh));
  }, []);
  const hostFor = (target: string) => hosts?.find((h) => h.target.toLowerCase() === target.toLowerCase());

  useEffect(() => {
    if (!focusMachine || !machines) return;
    const toggle = document.getElementById(`machine-${domId(focusMachine)}-name`);
    if (toggle) {
      toggle.focus();
      setFocusMachine(null);
    }
  }, [focusMachine, machines]);

  const check = async (target: string) => {
    setChecks((c) => ({ ...c, [target]: "checking" }));
    try {
      const status = await window.aya.machinesCheck(target);
      setChecks((c) => ({ ...c, [target]: status }));
      await refreshHosts();
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
  /** Re-reads every added machine and checks every suggestion; the suggestions open so their results show. */
  const checkAll = async () => {
    setCheckingAll(true);
    if (suggested.length) setShowSuggested(true);
    try {
      await Promise.all([reload(), ...suggested.map((s) => check(s.target))]);
    } finally {
      setCheckingAll(false);
    }
  };

  return (
    <section className="aya-settings-pane aya-machines" role="tabpanel" id="settings-panel-machines" aria-labelledby="settings-tab-machines">
      <div className="aya-settings-header aya-machines-header">
        <div className="aya-settings-header-icon">
          <span className="aya-settings-material" style={{ fontFamily: "Material Symbols Outlined" }} aria-hidden="true">
            dns
          </span>
        </div>
        <div className="aya-machines-title">
          <h2 className="aya-modal-title" ref={headingRef} tabIndex={-1}>
            Machines
          </h2>
          <p id="machines-hint" className="aya-modal-hint">
            Your own machines with Ollama, read over ssh. Aya asks before it adds one and never loads or unloads a model.
          </p>
        </div>
        <button type="button" className="aya-modal-btn aya-machines-check-all" onClick={() => void checkAll()} disabled={checkingAll || machines === null}>
          {checkingAll ? "Checking..." : "Check all"}
        </button>
      </div>
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
            aria-describedby={sentenceError ? "machines-hint machines-sentence-error" : "machines-hint"}
            aria-invalid={sentenceError ? true : undefined}
            spellCheck={false}
          />
          <button type="submit" className="aya-modal-btn aya-modal-btn--primary" disabled={adding !== null}>
            {adding === "sentence" ? "Finding..." : "Find"}
          </button>
        </div>
      </form>
      {sentenceError && (
        <p id="machines-sentence-error" className="aya-machine-error aya-machines-find-error" role="alert">
          {sentenceError}
        </p>
      )}
      <div role="status" aria-live="polite">
        {answer && <pre className="aya-machines-answer" data-testid="machines-answer">{answer}</pre>}
      </div>

      {loadError && (
        <p className="aya-machine-error" role="alert">
          Could not read the machines: {loadError}
        </p>
      )}

      <h3 id="machines-added" className="aya-machines-heading">
        Added{machines && machines.length > 0 ? ` (${machines.length})` : ""}
      </h3>
      {machines === null ? (
        <p className="aya-modal-hint" role="status">Checking the added machines...</p>
      ) : machines.length === 0 ? (
        <p className="aya-machines-empty" data-testid="machines-empty">
          No machines yet. Add one from the suggestions below, or name them in one sentence above.
        </p>
      ) : (
        <table className="aya-machines-table" aria-labelledby="machines-added">
          <thead>
            <tr>
              <th scope="col" className="aya-mcol-name">Machine</th>
              <th scope="col" className="aya-mcol-status">Status</th>
              <th scope="col" className="aya-mcol-num aya-mcol-gpu">GPU</th>
              <th scope="col" className="aya-mcol-num">VRAM GB</th>
              <th scope="col" className="aya-mcol-num aya-mcol-cpu">Load/cores</th>
              <th scope="col" className="aya-mcol-num aya-mcol-mem">RAM GB</th>
              <th scope="col" className="aya-mcol-model">Model</th>
              <th scope="col" className="aya-mcol-use">In use</th>
              <th scope="col" className="aya-mcol-more">
                <span className="aya-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {machines.map((m) => (
            <MachineRow
              key={m.id}
              machine={m}
              host={m.reach === "local" ? undefined : hostFor(m.reach.ssh)}
              onChanged={reload}
              onChecked={refreshHosts}
              onRemoved={() => {
                headingRef.current?.focus();
                void reload();
              }}
            />
          ))}
        </table>
      )}

      <h3 className="aya-machines-heading">
        <button
          type="button"
          className="aya-machine-toggle aya-machines-section-toggle"
          aria-expanded={showSuggested}
          aria-controls="machines-suggested"
          onClick={() => setShowSuggested((v) => !v)}
        >
          Suggested{hosts !== null ? ` (${suggested.length})` : ""}
        </button>
      </h3>
      <div id="machines-suggested" hidden={!showSuggested}>
        <p className="aya-modal-hint aya-machines-section-hint">
          From ~/.ssh/config, remote projects and this machine. Aya connects only to the ones you check.
        </p>
        {hosts === null ? (
          <p className="aya-modal-hint" role="status">Reading known hosts...</p>
        ) : suggested.length === 0 ? (
          <p className="aya-modal-hint">No other known hosts.</p>
        ) : (
          <ul className="aya-machines-list">
            {suggested.map((s) => (
              <SuggestionRow
                key={s.target}
                s={s}
                result={checks[s.target]}
                adding={adding}
                onCheck={() => void check(s.target)}
                onAdd={() => void add(["add", s.target], s.target)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
