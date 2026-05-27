import { useEffect, useRef, useState } from "react";

interface Props {
  defaultDirectory?: string;
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  pathHint?: string;
  onPickDirectory?: () => Promise<string | null>;
  onCompletePath?: (pathPrefix: string) => Promise<string[]>;
  onSubmit: (directory: string) => Promise<void> | void;
  onCancel: () => void;
}

export function NewProjectModal({
  defaultDirectory = "~/",
  lockDirectory = false,
  title = "Open project",
  hint = "Type a project directory, or browse for one.",
  pathHint,
  onPickDirectory,
  onCompletePath,
  onSubmit,
  onCancel,
}: Props) {
  const [directory, setDirectory] = useState(defaultDirectory || "~/");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const completionRef = useRef<{
    source: string;
    matches: string[];
    index: number;
    applied: string;
  } | null>(null);

  useEffect(() => {
    const input = directoryRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const setDirectoryAndMaybeName = (next: string) => {
    setDirectory(next);
    setError(null);
    completionRef.current = null;
  };

  const pickDirectory = async () => {
    if (!onPickDirectory || submitting) return;
    const picked = await onPickDirectory();
    if (!picked) return;
    setDirectoryAndMaybeName(picked);
  };

  const completeDirectory = async () => {
    if (!onCompletePath || submitting) return;
    const current = directory.trim() || "~/";
    const previous = completionRef.current;
    const isCycling = previous && previous.applied === current;
    const source = isCycling ? previous.source : current;
    const matches = isCycling
      ? previous.matches
      : await onCompletePath(source);
    if (matches.length === 0) {
      setError("No matching directories.");
      completionRef.current = null;
      return;
    }
    const index = isCycling ? (previous.index + 1) % matches.length : 0;
    const applied = matches[index];
    completionRef.current = { source, matches, index, applied };
    setDirectory(applied);
    setError(null);
  };

  const submit = async () => {
    if (submitting) return;
    const d = directory.trim();
    if (!d) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="aya-modal-backdrop"
      onClick={submitting ? undefined : onCancel}
    >
      <div className="aya-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aya-modal-title">{title}</div>
        {hint && <div className="aya-modal-hint">{hint}</div>}
        {pathHint && (
          <div className="aya-modal-hint aya-modal-hint--path">{pathHint}</div>
        )}

        {!lockDirectory && (
          <>
            <label className="aya-modal-label">Directory</label>
            <div className="aya-modal-input-row">
              <input
                ref={directoryRef}
                className="aya-modal-input"
                value={directory}
                onChange={(e) => setDirectoryAndMaybeName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    submit();
                  } else if (e.key === "Tab") {
                    e.preventDefault();
                    void completeDirectory();
                  }
                }}
                placeholder="~/code/project"
                disabled={submitting}
                spellCheck={false}
              />
              {onPickDirectory && (
                <button
                  className="aya-modal-btn"
                  onClick={pickDirectory}
                  disabled={submitting}
                >
                  Browse
                </button>
              )}
            </div>
          </>
        )}

        {error && <div className="aya-modal-error">{error}</div>}

        <div className="aya-modal-actions">
          <button
            className="aya-modal-btn"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={submit}
            disabled={submitting || !directory.trim()}
          >
            {submitting ? "Opening..." : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
