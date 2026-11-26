// "Send to several agents": one prompt, several Conversation GUI agents, one
// worktree + branch each. FanOutHost listens for the window events that
// gui-fan-out.ts dispatches (from a composer or the sidebar), so the entry
// points need no props threaded through the pane tree.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { guiSupportedAgent } from "../agentPreset";
import type { DiffAnchor } from "../diff-review";
import {
  FAN_OUT_COMPARE_EVENT, FAN_OUT_MAX_CHOICES, FAN_OUT_OPEN_EVENT, fanOutRun, fanOutSlug, fanOutSummary, planFanOut,
  queueFanOutMessage, recordFanOutRun, requestFanOutCompare, takeFanOutMessage,
  type FanOutAttachment, type FanOutDraft, type FanOutOutcome, type FanOutRun,
} from "../gui-fan-out";
import type { DiffComment, Preset, ProjectConfig } from "../types";
import { uuid } from "../uuid";
import { DiffPanel } from "./DiffPanel";
import "./fan-out.css";
import { useModalFocus } from "./useModalFocus";

/** Presets whose agent has a Conversation GUI: a fan-out pane always opens as a Conversation. */
export function fanOutPresets(presets: Preset[]): Preset[] {
  return presets.filter(p => guiSupportedAgent(p) !== null);
}

interface HostProps {
  projects: ProjectConfig[];
  activeProjectId: string | null;
  presets: Preset[];
  /** Open a GUI pane for `preset` in `cwd`; false when the project is gone. */
  launch: (preset: Preset, cwd: string, projectSlug: string, terminalId: string) => boolean;
  onWorktreesChanged: () => void;
  onOpenChange: (open: boolean) => void;
}

export function FanOutHost({ projects, activeProjectId, presets, launch, onWorktreesChanged, onOpenChange }: HostProps) {
  const [draft, setDraft] = useState<(FanOutDraft & { project: ProjectConfig }) | null>(null);
  const [compare, setCompare] = useState<FanOutRun | null>(null);
  const projectsRef = useRef(projects); projectsRef.current = projects;
  const activeRef = useRef(activeProjectId); activeRef.current = activeProjectId;
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<FanOutDraft>).detail ?? {};
      const project = projectsRef.current.find(p => p.slug === (detail.projectSlug ?? activeRef.current));
      if (!project || project.remote) return;
      setCompare(null); setDraft({ ...detail, project });
    };
    const openCompare = (event: Event) => {
      const run = fanOutRun((event as CustomEvent<{ runId: string }>).detail?.runId ?? "");
      if (run) { setDraft(null); setCompare(run); }
    };
    window.addEventListener(FAN_OUT_OPEN_EVENT, open);
    window.addEventListener(FAN_OUT_COMPARE_EVENT, openCompare);
    return () => { window.removeEventListener(FAN_OUT_OPEN_EVENT, open); window.removeEventListener(FAN_OUT_COMPARE_EVENT, openCompare); };
  }, []);
  const isOpen = !!draft || !!compare;
  useEffect(() => { onOpenChange(isOpen); }, [isOpen, onOpenChange]);
  // A project switch while the dialog is open would start agents in a project the user is no longer looking at.
  useEffect(() => { if (draft && draft.project.slug !== activeProjectId) setDraft(null); }, [activeProjectId, draft]);
  if (compare) return <FanOutCompareDialog run={compare} onClose={() => setCompare(null)} />;
  if (!draft) return null;
  return <FanOutDialog key={draft.project.slug} draft={draft} project={draft.project} presets={fanOutPresets(presets)}
    launch={launch} onWorktreesChanged={onWorktreesChanged} onClose={() => setDraft(null)} onCompare={id => requestFanOutCompare(id)} />;
}

function FanOutDialog({ draft, project, presets, launch, onWorktreesChanged, onClose, onCompare }: {
  draft: FanOutDraft;
  project: ProjectConfig;
  presets: Preset[];
  launch: HostProps["launch"];
  onWorktreesChanged: () => void;
  onClose: () => void;
  onCompare: (runId: string) => void;
}) {
  const [text, setText] = useState(draft.text ?? "");
  const [attachments, setAttachments] = useState<FanOutAttachment[]>(draft.attachments ?? []);
  const [chosen, setChosen] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [slugInput, setSlugInput] = useState<string | null>(null);
  const slug = slugInput ?? fanOutSlug(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<FanOutOutcome<Preset>[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  useModalFocus(dialogRef, onClose, { blocked: busy });
  useEffect(() => {
    let cancelled = false;
    void window.aya.getGitInfo(project.directory).then(info => { if (!cancelled) setBase(old => old || (info.branch ?? "HEAD")); }).catch(() => { if (!cancelled) setBase(old => old || "HEAD"); });
    return () => { cancelled = true; };
  }, [project.directory]);
  const plan = useMemo(() => planFanOut(slug, chosen.map(id => presets.find(p => p.id === id)).filter((p): p is Preset => !!p)), [slug, chosen, presets]);
  const toggle = (id: string, on: boolean) => setChosen(old => on ? (old.includes(id) || old.length >= FAN_OUT_MAX_CHOICES ? old : [...old, id]) : old.filter(x => x !== id));
  const canStart = !busy && plan.length > 0 && !!text.trim() && !!base.trim();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true); setError(null);
    try {
      const created = await window.aya.createFanOutWorktrees({ directory: project.directory, base: base.trim(), names: plan.map(p => p.name) });
      if (created.error || !created.base) { setError(created.error ?? "Could not create worktrees."); return; }
      const message = { text: text.trim(), attachments: attachments.length && draft.sourceTerminalId ? { from: draft.sourceTerminalId, ids: attachments.map(a => a.id) } : null };
      const results: FanOutOutcome<Preset>[] = plan.map(({ preset, name }, index) => {
        const result = created.results[index];
        if (!result || !result.ok) return { preset, name, ok: false, error: result && !result.ok ? result.error : "Not created." };
        const terminalId = uuid();
        queueFanOutMessage(terminalId, message);
        if (!launch(preset, result.path, project.slug, terminalId)) {
          takeFanOutMessage(terminalId);
          return { preset, name, ok: false, error: `The worktree ${result.branch} was created, but the project closed before the pane opened.` };
        }
        return { preset, name, ok: true, path: result.path, branch: result.branch, terminalId };
      });
      if (results.some(r => r.ok)) {
        const id = uuid();
        recordFanOutRun({
          id, projectSlug: project.slug, projectDir: project.directory, base: created.base, baseLabel: base.trim(),
          branches: results.flatMap(r => r.ok ? [{ terminalId: r.terminalId, label: r.preset.name, branch: r.branch, path: r.path }] : []),
        });
        setRunId(id);
        onWorktreesChanged();
      }
      setOutcomes(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create worktrees.");
    } finally { setBusy(false); }
  };

  return (
    <div className="aya-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form ref={dialogRef} className="aya-modal aya-worktree-dialog aya-fan-out-dialog" role="dialog" aria-modal="true" aria-labelledby="fan-out-title" onSubmit={submit}>
        <h2 id="fan-out-title">Send to several agents</h2>
        {outcomes ? <>
          <p role="status">{fanOutSummary(outcomes)}</p>
          <ul className="aya-fan-out-results" aria-label="Agents">
            {outcomes.map(o => <li key={o.name} data-ok={o.ok || undefined}>
              <span aria-hidden="true">{o.ok ? "✓" : "✕"}</span> <strong>{o.preset.name}</strong>{" "}
              {o.ok ? <code>{o.branch}</code> : <span className="aya-worktree-dialog-error">{o.error}</span>}
            </li>)}
          </ul>
          <p className="aya-worktree-dialog-hint">Each agent works in its own worktree. Compare shows what each branch changed since {base.trim()}.</p>
          <div className="aya-modal-actions">
            {runId && <button className="aya-modal-btn" type="button" onClick={() => onCompare(runId)}>Compare</button>}
            <button className="aya-modal-btn aya-modal-btn--primary" type="button" autoFocus onClick={onClose}>Done</button>
          </div>
        </> : <>
          <p>Start the same prompt in a separate worktree for each agent, then compare their branches.</p>
          <label>Prompt
            <textarea value={text} onChange={e => setText(e.target.value)} aria-label="Prompt" rows={4} autoFocus />
          </label>
          {attachments.length > 0 && <ul className="aya-fan-out-attachments" aria-label="Attachments">
            {attachments.map(a => <li key={a.id}>📎 {a.name} <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments(old => old.filter(x => x.id !== a.id))}>×</button></li>)}
          </ul>}
          <fieldset className="aya-fan-out-agents">
            <legend>Agents (up to {FAN_OUT_MAX_CHOICES})</legend>
            {presets.length === 0 && <small>No Conversation GUI presets yet. Turn on “Conversation GUI” for a Claude, Codex, Pi or Antigravity preset in Settings → Presets.</small>}
            {presets.map(p => <label key={p.id}><input type="checkbox" checked={chosen.includes(p.id)} disabled={!chosen.includes(p.id) && chosen.length >= FAN_OUT_MAX_CHOICES} onChange={e => toggle(p.id, e.target.checked)} /> <span style={p.color ? { color: p.color } : undefined}>{p.icon}</span> {p.name}</label>)}
          </fieldset>
          <label>Starting branch or ref
            <input value={base} onChange={e => setBase(e.target.value)} aria-label="Starting branch or ref" />
          </label>
          <p className="aya-worktree-dialog-hint">Each agent starts from its last commit; uncommitted changes are not included.</p>
          <label>Worktree name
            <input value={slug} onChange={e => setSlugInput(e.target.value)} aria-label="Worktree name" />
          </label>
          {plan.length > 0 && <p className="aya-worktree-dialog-hint" data-testid="fan-out-branches">Creates {plan.map(p => `aya/${p.name}`).join(", ")}</p>}
          {error && <p className="aya-worktree-dialog-error" role="alert">{error}</p>}
          <div className="aya-modal-actions">
            <button className="aya-modal-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="aya-modal-btn aya-modal-btn--primary" type="submit" disabled={!canStart}>{busy ? "Creating…" : plan.length ? `Start ${plan.length} agent${plan.length === 1 ? "" : "s"}` : "Start agents"}</button>
          </div>
        </>}
      </form>
    </div>
  );
}

/** Each fan-out branch's diff against the shared base commit, one tab per agent. Comments land in
 *  Aya's review store for that checkout, so they show up under "@ Context" in that agent's composer. */
function FanOutCompareDialog({ run, onClose }: { run: FanOutRun; onClose: () => void }) {
  const [selected, setSelected] = useState(run.branches[0]?.path ?? "");
  const branch = run.branches.find(b => b.path === selected) ?? run.branches[0];
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState("");
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [commentError, setCommentError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, onClose);
  const load = useCallback((path: string) => {
    setDiffs(old => ({ ...old, [path]: null }));
    void window.aya.fanOutDiff({ checkout: path, base: run.base })
      .then(diff => setDiffs(old => ({ ...old, [path]: diff })))
      .catch(() => setDiffs(old => ({ ...old, [path]: "" })));
  }, [run.base]);
  useEffect(() => { for (const b of run.branches) load(b.path); }, [run, load]);
  useEffect(() => {
    let cancelled = false;
    void window.aya.listDiffComments(run.projectSlug).then(saved => { if (!cancelled) setComments(saved); }).catch(() => {});
    return () => { cancelled = true; };
  }, [run.projectSlug]);
  const save = async (work: Promise<DiffComment[]>) => {
    try { setComments(await work); setCommentError(null); }
    catch (err) { setCommentError(err instanceof Error ? err.message : "Aya could not save that comment."); throw err; }
  };
  const diff = branch ? diffs[branch.path] : "";
  const stats = (text: string | null | undefined) => {
    if (!text) return text === "" ? "no changes" : "…";
    const files = text.split("\n").filter(l => l.startsWith("diff --git")).length;
    return `${files} file${files === 1 ? "" : "s"}`;
  };
  return (
    <div className="aya-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="aya-modal aya-fan-out-compare" role="dialog" aria-modal="true" aria-labelledby="fan-out-compare-title">
        <div className="aya-fan-out-compare-head">
          <h2 id="fan-out-compare-title">Compare agents</h2>
          <small>Changes since {run.baseLabel} ({run.base.slice(0, 8)})</small>
          <button className="aya-modal-btn" type="button" onClick={() => branch && load(branch.path)}>Refresh</button>
          <button className="aya-modal-btn" type="button" onClick={onClose}>Close</button>
        </div>
        <div role="tablist" aria-label="Branches" className="aya-fan-out-tabs">
          {run.branches.map(b => <button key={b.path} type="button" role="tab" aria-selected={b.path === branch?.path} onClick={() => setSelected(b.path)}>
            <strong>{b.label}</strong> <code>{b.branch}</code> <small>{stats(diffs[b.path])}</small>
          </button>)}
        </div>
        {branch && <div role="tabpanel" aria-label={`${branch.label} diff`} className="aya-fan-out-compare-body">
          <DiffPanel
            diff={diff ?? ""}
            loading={diff === null || diff === undefined}
            query={query}
            onQueryChange={setQuery}
            scrollToPath={null}
            onScrolled={() => {}}
            comments={comments.filter(c => c.checkout === branch.path)}
            commentsLoading={false}
            commentError={commentError}
            onAddComment={(anchor: DiffAnchor, note: string) => save(window.aya.addDiffComment(run.projectSlug, {
              ...anchor, id: uuid(), checkout: branch.path, note, createdAt: new Date().toISOString(), sentAt: null, sentTo: null,
            }))}
            onEditComment={(id, note) => save(window.aya.editDiffComment(run.projectSlug, id, note))}
            onDeleteComment={id => void save(window.aya.deleteDiffComment(run.projectSlug, id)).catch(() => {})}
            onClearSent={() => void save(window.aya.clearSentDiffComments(run.projectSlug)).catch(() => {})}
            targets={[]}
            targetId={null}
            onTargetChange={() => {}}
            sending={false}
            onSend={() => {}}
          />
          <small className="aya-fan-out-compare-hint">Comments on {branch.branch} appear under “@ Context” in the {branch.label} conversation.</small>
        </div>}
      </div>
    </div>
  );
}
