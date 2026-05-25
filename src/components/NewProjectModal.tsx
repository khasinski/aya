import { useEffect, useRef, useState } from "react";

interface Props {
  defaultName?: string;
  defaultDirectory?: string;
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  onSubmit: (name: string, directory: string) => void;
  onCancel: () => void;
}

export function NewProjectModal({
  defaultName = "",
  defaultDirectory = "",
  lockDirectory = false,
  title = "New project",
  hint,
  onSubmit,
  onCancel,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [directory, setDirectory] = useState(defaultDirectory);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => {
    const n = name.trim();
    const d = directory.trim();
    if (!n || !d) return;
    onSubmit(n, d);
  };

  return (
    <div className="aya-modal-backdrop" onClick={onCancel}>
      <div className="aya-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aya-modal-title">{title}</div>
        {hint && <div className="aya-modal-hint aya-modal-hint--path">{hint}</div>}
        <label className="aya-modal-label">Name</label>
        <input
          ref={nameRef}
          className="aya-modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="project name"
        />
        {/* The directory field only renders when not locked. The two-step flow
            (pick dir, then name it) keeps the dialog focused and avoids users
            typing paths by hand. */}
        {!lockDirectory && (
          <>
            <label className="aya-modal-label">Directory</label>
            <input
              className="aya-modal-input"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="/path/to/project"
            />
          </>
        )}
        <div className="aya-modal-actions">
          <button className="aya-modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={submit}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
