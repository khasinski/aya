interface Props {
  showNoHarnessHint: boolean;
  onOpenProject: () => void;
  onOpenSettings: () => void;
  onDismissNoHarnessHint: () => void;
}

export function EmptyState({
  showNoHarnessHint,
  onOpenProject,
  onOpenSettings,
  onDismissNoHarnessHint,
}: Props) {
  return (
    <main className="aya-empty">
      <div className="aya-empty-mark" aria-hidden="true">
        <span />
      </div>
      <h1>No projects yet</h1>
      <p>
        Open a directory to start a project. Aya will create the project and add
        a shell automatically.
      </p>
      <div className="aya-empty-actions">
        <button
          className="aya-modal-btn aya-modal-btn--primary"
          onClick={onOpenProject}
        >
          Open directory
        </button>
        <button className="aya-modal-btn" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
      {showNoHarnessHint && (
        <div className="aya-empty-hint">
          <div>
            <strong>No agent CLI found yet.</strong>
            <span>Aya can still open shells. Add Claude, Codex, or another CLI later from Settings.</span>
          </div>
          <button className="aya-empty-hint-dismiss" onClick={onDismissNoHarnessHint}>
            Dismiss
          </button>
        </div>
      )}
    </main>
  );
}
