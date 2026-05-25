import { useEffect, useState } from "react";

interface Props {
  projectName: string;
  directory: string;
  homeDir: string;
  /** Caller does the actual mkdir; this just notifies which choice was made. */
  onCreate: () => Promise<void>;
  onUseHome: () => void;
  onClose: () => void;
}

export function MissingDirModal({
  projectName,
  directory,
  homeDir,
  onCreate,
  onUseHome,
  onClose,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      await onCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  };

  return (
    <div className="aya-modal-backdrop" onClick={onClose}>
      <div className="aya-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aya-modal-title">Directory not found</div>
        <div className="aya-modal-hint">
          Project <strong>{projectName}</strong> points at a folder that
          doesn't exist.
        </div>
        <div className="aya-modal-hint aya-modal-hint--path">{directory}</div>

        <div className="aya-modal-hint" style={{ marginTop: 12 }}>
          Create the folder, or skip and let terminals for this project open in
          your home directory until it's there.
        </div>
        <div className="aya-modal-hint aya-modal-hint--path">{homeDir}</div>

        {error && (
          <div className="aya-settings-errors" style={{ marginTop: 12 }}>
            Couldn't create: {error}
          </div>
        )}

        <div className="aya-modal-actions">
          <button
            className="aya-modal-btn"
            onClick={onUseHome}
            disabled={creating}
          >
            Use home for now
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? "Creating…" : "Create folder"}
          </button>
        </div>
      </div>
    </div>
  );
}
