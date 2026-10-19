// Settings > Machines: setup only. Add and remove machines here; their live state is the status bar's item.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiCandidate, KnownHost, MachineSetup } from "../types";
import { addAnswerText, MACHINES_CHANGED_EVENT, reachText } from "../machines-view";

// The fields are off while a save runs, as the backend select is: the save reloads the machines, and an editor whose
// URL or token state changed comes back new (its key), dropping what was typed meanwhile.
function BackendEditor({ machine, busy, save }: { machine: MachineSetup; busy: boolean; save: (argv: string[], token?: string) => Promise<void> }) {
  const [backend, setBackend] = useState(machine.api ? "openai-compatible" : "ollama");
  const [url, setUrl] = useState(machine.api?.baseUrl ?? "");
  const [port, setPort] = useState(String(machine.ollama.port));
  const [token, setToken] = useState("");
  const [clear, setClear] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<ApiCandidate[]>([]);
  const [discoveryText, setDiscoveryText] = useState<string | null>(null);
  const generation = useRef(0);
  const urlRef = useRef(url);
  const credentialsEdited = useRef(false);
  const invalidateDiscovery = () => {
    generation.current++;
    setDiscovering(false); setCandidates([]); setDiscoveryText(null);
  };
  const editUrl = (value: string) => {
    invalidateDiscovery(); urlRef.current = value; setUrl(value); setToken(""); setClear(false);
  };
  const discover = useCallback(async () => {
    const current = ++generation.current;
    setDiscovering(true); setCandidates([]); setDiscoveryText(null);
    try {
      const result = await window.aya.machinesDiscover(machine.id);
      if (current !== generation.current) return;
      if (result.candidates.length === 1 && !urlRef.current.trim() && !credentialsEdited.current) {
        const candidate = result.candidates[0];
        urlRef.current = candidate.baseUrl; setUrl(candidate.baseUrl); setToken(""); setClear(false);
        setCandidates([]);
        setDiscoveryText(candidate.kind === "confirmed" ? "Endpoint confirmed by its model list. Save backend to apply." : "Requires authentication · compatibility unconfirmed. Enter a bearer token, then Save backend.");
      } else {
        setCandidates(result.candidates);
        setDiscoveryText(result.error ?? (result.candidates.length ? "Choose an endpoint below. Nothing is saved until Save backend." : "No API endpoint found on ports 8080, 8000, 1234 or 5000. Enter a URL manually or retry."));
      }
    } catch {
      if (current === generation.current) setDiscoveryText("Endpoint discovery failed. Enter a URL manually or retry.");
    } finally { if (current === generation.current) setDiscovering(false); }
  }, [machine.id]);
  useEffect(() => {
    const lifetime = generation;
    if (backend === "openai-compatible" && !urlRef.current.trim()) void discover();
    return () => { lifetime.current++; };
  }, [backend, discover]);
  return <form className="aya-machines-backend" aria-label={`Backend for ${machine.id}`} onSubmit={(e) => {
    e.preventDefault();
    const argv = ["configure", machine.id, backend, backend === "ollama" ? port : url];
    if (backend === "openai-compatible" && token) argv.push("--token-stdin");
    else if (backend === "openai-compatible" && clear) argv.push("--clear-token");
    void save(argv, backend === "openai-compatible" && token ? token : undefined).then(() => { setToken(""); setClear(false); }).catch(() => {});
  }}>
    <label>Backend <select className="aya-modal-input" aria-label={`Backend for ${machine.id}`} value={backend} disabled={busy} onChange={(e) => { invalidateDiscovery(); credentialsEdited.current = false; setBackend(e.target.value); setToken(""); setClear(false); }}>
      <option value="ollama">Ollama</option><option value="openai-compatible">OpenAI-compatible API</option>
    </select></label>
    {backend === "ollama" ? <label>Ollama port <input className="aya-modal-input" type="number" min={1} max={65535} value={port} disabled={busy} onChange={(e) => setPort(e.target.value)} /></label> : <>
      <label>API URL <input className="aya-modal-input" type="url" required aria-label={`API URL for ${machine.id}`} placeholder="http://host:8080/v1" value={url} disabled={busy} onChange={(e) => editUrl(e.target.value)} /></label>
      <div className="aya-machines-discovery" aria-label={`Endpoint discovery for ${machine.id}`}>
        <button className="aya-modal-btn" type="button" disabled={busy || discovering} onClick={() => void discover()}>{discovering ? "Searching this host…" : "Search again"}</button>
        <div className="aya-modal-hint">Checks four common ports on this machine, without a token. You can also enter the URL manually.</div>
        {discoveryText && <div className="aya-modal-hint" role="status">{discoveryText}</div>}
        {candidates.map((c) => <div className="aya-machines-discovery-candidate" key={c.baseUrl}>
          <span>{c.baseUrl}<small className="aya-machines-muted">{c.kind === "confirmed" ? "Confirmed by model list" : "Requires authentication · compatibility unconfirmed. Enter a bearer token after choosing."}</small></span>
          <button className="aya-modal-btn" type="button" disabled={busy} onClick={() => editUrl(c.baseUrl)} aria-label={`Use ${c.baseUrl}`}>Use endpoint</button>
        </div>)}
      </div>
      <label>Bearer token <input className="aya-modal-input" type="password" autoComplete="new-password" aria-label={`Bearer token for ${machine.id}`} value={token} disabled={busy} onChange={(e) => { credentialsEdited.current = true; setToken(e.target.value); setClear(false); }} /></label>
      <div className="aya-modal-hint">{machine.api?.tokenConfigured && url === machine.api.baseUrl ? clear ? "Saved token will be cleared on Save backend." : <>
        Token saved. {machine.api.savedTokenPreview && <>Saved token: <code>{machine.api.savedTokenPreview}</code>. </>}Leave blank to keep it for this URL.
      </> : "No token saved for this URL. Leave blank for an API without authentication."}</div>
      <label><input type="checkbox" checked={clear} disabled={busy} onChange={(e) => { credentialsEdited.current = true; setClear(e.target.checked); if (e.target.checked) setToken(""); }} /> Clear saved token</label>
    </>}
    <button className="aya-modal-btn" type="submit" disabled={busy}>Save backend</button>
  </form>;
}

export function MachinesSettings() {
  const [machines, setMachines] = useState<MachineSetup[]>([]);
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

  const configure = async (argv: string[], token?: string) => {
    setBusy(true);
    setAnswer(null);
    try {
      setAnswer((await window.aya.machinesConfigure(argv, token)).trim());
      window.dispatchEvent(new Event(MACHINES_CHANGED_EVENT));
      await load();
    } catch (err) {
      setAnswer((err as Error).message);
      throw err;
    } finally { setBusy(false); }
  };

  const suggestions = [
    ...(machines.some((m) => m.reach === "local") ? [] : [{ target: "this machine", label: "this machine" }]),
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
                {reachText(m.reach)} · {m.api ? `API ${m.api.baseUrl}` : `Ollama port ${m.ollama.port}`}
              </span>
              <button className="aya-modal-btn" type="button" disabled={busy} onClick={() => void run(["remove", m.id])}>
                Remove
              </button>
              <BackendEditor key={`${m.id}:${reachText(m.reach)}:${m.api?.baseUrl ?? m.ollama.port}:${m.api?.tokenConfigured}`} machine={m} busy={busy} save={configure} />
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
