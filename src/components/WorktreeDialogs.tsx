import { useEffect, useState, type FormEvent } from "react";
import type { Preset, Worktree } from "../types";

const MAX_VISIBLE_WORKTREES = 6;
const DEFAULT_WORKTREES_PER_PROMPT = 2;

interface CreateProps {
  projectDir: string;
  presets: Preset[];
  onCancel: () => void;
  onCreate: (req: { directory: string; slug: string; count: number; base: string }) => Promise<{ created: { path: string; branch: string }[]; errors: string[] }>;
  onStart: (preset: Preset, checkouts: { path: string; branch: string }[], prompt: string) => void;
}

export function WorktreeCreateDialog({ projectDir, presets, onCancel, onCreate, onStart }: CreateProps) {
  const [slug, setSlug] = useState("");
  const [count, setCount] = useState(DEFAULT_WORKTREES_PER_PROMPT);
  const [base, setBase] = useState("");
  const [presetId, setPresetId] = useState(presets[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<{ created: { path: string; branch: string }[]; errors: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.aya.getGitInfo(projectDir).then((info) => {
      if (!cancelled) {
        setBase(info.branch ?? "HEAD");
        setSlug((info.branch ?? "work").replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, ""));
      }
    });
    return () => { cancelled = true; };
  }, [projectDir]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const preset = presets.find((item) => item.id === presetId);
    if (!preset || !prompt.trim() || !slug.trim() || !base.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onCreate({ directory: projectDir, slug, count, base });
      if (result.created.length) {
        onStart(preset, result.created, prompt.trim());
        setFinished(result);
      }
      if (result.errors.length) {
        setError(`${result.created.length} worktree${result.created.length === 1 ? "" : "s"} started. Some could not be created: ${result.errors.join("; ")}`);
        setBusy(false);
      } else {
        onCancel();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create worktrees.");
      setBusy(false);
    }
  };

  return (
    <div className="aya-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <form className="aya-modal aya-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-create-title" onSubmit={submit}>
        <h2 id="worktree-create-title">Start in worktrees</h2>
        <p>Start up to 6 copies of this task in separate worktrees.</p>
        <label>Starting branch or ref
          <input autoFocus value={base} onChange={(e) => setBase(e.target.value)} aria-label="Starting branch or ref" />
        </label>
        <label>Worktree name
          <input value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Worktree name" />
        </label>
        <label>Number of worktrees (1–6)
          <input type="number" min={1} max={MAX_VISIBLE_WORKTREES} value={count} onChange={(e) => setCount(Math.max(1, Math.min(MAX_VISIBLE_WORKTREES, Number(e.target.value) || 1)))} aria-label="Number of worktrees" />
        </label>
        <label>Agent
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} aria-label="Agent preset">
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
        <label>Prompt
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" rows={5} />
        </label>
        {finished && <p role="status">Started {finished.created.map((item) => item.branch).join(", ")}.</p>}
        {error && <p className="aya-worktree-dialog-error" role="status">{error}</p>}
        <div className="aya-modal-actions">
          <button className="aya-modal-btn" type="button" onClick={onCancel} disabled={busy}>{finished ? "Done" : "Cancel"}</button>
          {!finished && <button className="aya-modal-btn aya-modal-btn--primary" type="submit" disabled={busy || !presets.length || !prompt.trim() || !slug.trim() || !base.trim()}>{busy ? "Creating…" : "Start worktrees"}</button>}
        </div>
      </form>
    </div>
  );
}

interface RemoveProps {
  projectDir: string;
  base: string;
  worktree: Worktree;
  onCancel: () => void;
  onRemove: (req: { directory: string; path: string; base: string; deleteBranch: boolean }) => Promise<{ ok: true; path: string; branchDeleted: boolean } | { ok: false; error: string }>;
  onRemoved: () => void;
}

export function WorktreeRemoveDialog({ projectDir, base, worktree, onCancel, onRemove, onRemoved }: RemoveProps) {
  const [info, setInfo] = useState<{ branch: string | null; canDelete: boolean; reason: string | null; unmerged: number | null } | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.aya.worktreeBranchRemovalInfo({ directory: projectDir, path: worktree.path, base }).then((result) => {
      if (cancelled) return;
      setInfo(result);
      setDeleteBranch(result.canDelete);
    });
    return () => { cancelled = true; };
  }, [projectDir, base, worktree.path]);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const result = await onRemove({ directory: projectDir, path: worktree.path, base, deleteBranch: deleteBranch && info?.canDelete === true });
    if (!result.ok) { setError(result.error); setBusy(false); return; }
    if (deleteBranch && !result.branchDeleted) window.alert("The worktree was removed. The branch was kept because it is no longer safe to delete.");
    onRemoved();
    onCancel();
  };
  return (
    <div className="aya-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="aya-modal aya-worktree-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-remove-title">
        <h2 id="worktree-remove-title">Remove worktree?</h2>
        <p>Remove the checkout at <code>{worktree.path}</code>.</p>
        {info?.branch && <label className="aya-worktree-delete-branch"><input type="checkbox" checked={deleteBranch && info.canDelete} disabled={!info.canDelete || busy} onChange={(e) => setDeleteBranch(e.target.checked)} /> Also delete branch <code>{info.branch}</code></label>}
        {info && !info.canDelete && <p className="aya-worktree-dialog-reason">{info.reason ?? "This branch will be kept."}</p>}
        {error && <p role="alert" className="aya-worktree-dialog-error">{error}</p>}
        <div className="aya-modal-actions"><button className="aya-modal-btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="aya-modal-btn aya-modal-btn--primary" type="button" onClick={() => void submit()} disabled={busy || !info}>{busy ? "Removing…" : "Remove worktree"}</button></div>
      </div>
    </div>
  );
}
