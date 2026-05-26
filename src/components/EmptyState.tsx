interface Props {
  onOpenProject: () => void;
  onOpenSettings: () => void;
}

export function EmptyState({ onOpenProject, onOpenSettings }: Props) {
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
    </main>
  );
}
