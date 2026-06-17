import { useEffect, useRef, useState } from "react";

interface Props {
  defaultDirectory?: string;
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  pathHint?: string;
  onPickDirectory?: () => Promise<string | null>;
  onCompletePath?: (pathPrefix: string) => Promise<string[]>;
  onDirectoryExists?: (directory: string) => Promise<boolean>;
  onCreateDirectory?: (directory: string) => Promise<void>;
  onSubmit: (directory: string) => Promise<void> | void;
  onCancel: () => void;
}

type DirectoryStatus = "unknown" | "checking" | "exists" | "missing";
const DIRECTORY_CHECK_DEBOUNCE_MS = 500;

export function NewProjectModal({
  defaultDirectory = "~/",
  lockDirectory = false,
  title = "Open project",
  hint = "Type a project directory, or browse for one.",
  pathHint,
  onPickDirectory,
  onCompletePath,
  onDirectoryExists,
  onCreateDirectory,
  onSubmit,
  onCancel,
}: Props) {
  const [directory, setDirectory] = useState(defaultDirectory || "~/");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directoryStatus, setDirectoryStatus] =
    useState<DirectoryStatus>("unknown");
  const directoryRef = useRef<HTMLInputElement>(null);
  const directoryCheckRef = useRef(0);
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
    setDirectoryStatus("unknown");
    completionRef.current = null;
  };

  useEffect(() => {
    if (lockDirectory || !onDirectoryExists) return;
    const current = directory.trim();
    const token = directoryCheckRef.current + 1;
    directoryCheckRef.current = token;
    if (!current) {
      setDirectoryStatus("unknown");
      return;
    }
    const timer = window.setTimeout(() => {
      if (directoryCheckRef.current === token) {
        setDirectoryStatus("checking");
      }
      void onDirectoryExists(current)
        .then((exists) => {
          if (directoryCheckRef.current === token) {
            setDirectoryStatus(exists ? "exists" : "missing");
          }
        })
        .catch(() => {
          if (directoryCheckRef.current === token) {
            setDirectoryStatus("unknown");
          }
        });
    }, DIRECTORY_CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [directory, lockDirectory, onDirectoryExists]);

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
      let status = directoryStatus;
      if (onDirectoryExists) {
        const exists = await onDirectoryExists(d);
        status = exists ? "exists" : "missing";
        setDirectoryStatus(status);
      }
      if (status === "missing" && onCreateDirectory) {
        await onCreateDirectory(d);
      }
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
            disabled={
              submitting ||
              !directory.trim() ||
              directoryStatus === "checking" ||
              (directoryStatus === "missing" && !onCreateDirectory)
            }
          >
            {submitting
              ? directoryStatus === "missing"
                ? "Creating..."
                : "Opening..."
              : directoryStatus === "missing" && onCreateDirectory
                ? "Create folder"
                : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
