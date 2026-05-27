import type { Preset, ProjectConfig } from "../types";

interface Props {
  project: ProjectConfig;
  presets: Preset[];
  onImport: () => void;
  onIgnore: () => void;
}

export function ProjectPresetImportModal({
  project,
  presets,
  onImport,
  onIgnore,
}: Props) {
  return (
    <div className="aya-modal-backdrop" onClick={onIgnore}>
      <section
        className="aya-modal aya-project-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Import project launchers"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aya-modal-title">Import project launchers?</div>
        <div className="aya-modal-hint">
          {project.name} includes .aya/project.json with suggested terminal
          launchers. Aya will add them to your launcher list, but will not run
          anything automatically.
        </div>
        <div className="aya-project-import-list">
          {presets.map((preset) => (
            <div className="aya-project-import-row" key={preset.id}>
              <span
                className="aya-project-import-icon"
                style={preset.color ? { color: preset.color } : undefined}
              >
                {preset.icon}
              </span>
              <span className="aya-project-import-main">
                <strong>{preset.name}</strong>
                <code>{preset.command}</code>
              </span>
            </div>
          ))}
        </div>
        <div className="aya-modal-actions">
          <button className="aya-modal-btn" onClick={onIgnore}>
            Ignore
          </button>
          <button className="aya-modal-btn aya-modal-btn--primary" onClick={onImport}>
            Import launchers
          </button>
        </div>
      </section>
    </div>
  );
}
