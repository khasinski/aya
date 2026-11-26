// A terminal pane's `aya present` artifacts (electron/tui-artifacts.ts): a header button with the Conversation view's
// artifact icon and count, listing each one (title, kind, revision, time) and opening it in its window. One that
// arrives while the user would not see it (stored with --no-open, or the pane is not focused) marks the button unseen
// until the list is opened. Self-contained, so a shared pane header can take it as is.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TuiArtifactSummary } from "../types";

const KIND_LABEL: Record<TuiArtifactSummary["kind"], string> = { html: "HTML", image: "Image", table: "Table", metric: "Metric" };

export function artifactTime(at: number, now = Date.now()): string {
  const d = new Date(at), today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/** Newest first, one row per artifact; an update replaces its row and moves it to the top. */
export function withArtifact(list: TuiArtifactSummary[], artifact: TuiArtifactSummary): TuiArtifactSummary[] {
  return [artifact, ...list.filter((a) => a.id !== artifact.id)];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export function TuiArtifactsButton({ terminalId, focused = true }: {
  terminalId: string;
  /** The pane has the user's attention: a new artifact that opened its own window is then not marked unseen. */
  focused?: boolean;
}) {
  const [artifacts, setArtifacts] = useState<TuiArtifactSummary[]>([]);
  const [unseen, setUnseen] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    let live = true;
    const off = window.aya.onTuiArtifactsChange((change) => {
      if (change.terminalId !== terminalId) return;
      setArtifacts((old) => withArtifact(old, change.artifact));
      if (!change.opened || !focusedRef.current || !document.hasFocus()) setUnseen((old) => old.includes(change.artifact.id) ? old : [...old, change.artifact.id]);
    });
    void window.aya.tuiArtifacts(terminalId).then((list) => { if (live) setArtifacts((old) => old.reduceRight(withArtifact, list)); }).catch(() => {});
    return () => { live = false; off(); };
  }, [terminalId]);
  useEffect(() => {
    if (!expanded) { setError(""); return; }
    setUnseen([]);
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !button.current?.contains(target)) setExpanded(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [expanded]);
  if (!artifacts.length) return null;
  const rect = expanded ? button.current?.getBoundingClientRect() : undefined;
  const label = `Artifacts (${artifacts.length})${unseen.length ? `, ${unseen.length} new` : ""}`;
  const open = (id: string) => {
    setError("");
    setUnseen((old) => old.filter((u) => u !== id));
    void window.aya.openTuiArtifact(terminalId, id).catch((e) => setError(message(e)));
  };
  return <>
    <button ref={button} type="button" className="aya-gui-icon-button aya-gui-artifact-button aya-tui-artifacts-button"
      data-unseen={unseen.length > 0 || undefined} aria-label={label} aria-expanded={expanded} aria-haspopup="dialog"
      title={unseen.length ? `${unseen.length} new artifact${unseen.length === 1 ? "" : "s"} from aya present` : "Artifacts this pane's agent presented"}
      onClick={() => setExpanded(!expanded)}>
      <span className="aya-gui-icon" aria-hidden="true">deployed_code</span><b aria-hidden="true">{artifacts.length}</b>
    </button>
    {expanded && createPortal(
      <div ref={popover} className="aya-servers-popover aya-tui-artifacts-popover" role="dialog" aria-label="Artifacts"
        style={rect ? { top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setExpanded(false); button.current?.focus(); } }}>
        <div className="aya-servers-title">Artifacts</div>
        <ul>
          {artifacts.map((a) => (
            <li key={a.id} data-artifact-id={a.id}>
              <button type="button" className="aya-tui-artifact-row" title={`Open ${a.title}`} onClick={() => open(a.id)}>
                <span className="aya-tui-artifact-title">{a.title}</span>
                <span className="aya-tui-artifact-meta">{KIND_LABEL[a.kind]} · r{a.revision} · {artifactTime(a.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && <div className="aya-servers-error" role="alert">{error}</div>}
      </div>,
      document.body,
    )}
  </>;
}
