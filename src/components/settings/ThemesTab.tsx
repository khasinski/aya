import { type Theme } from "../../types";
import { ThemeSwatch } from "./ThemeSwatch";
import { SettingsHeader, SettingsIcon } from "./parts";

interface ThemesTabProps {
  themes: Theme[];
  activeThemeId: string;
  setActiveTheme: (id: string) => void;
  deleteTheme: (id: string) => void;
  importTheme: () => Promise<void>;
  importError: string | null;
}

export function ThemesTab({
  themes,
  activeThemeId,
  setActiveTheme,
  deleteTheme,
  importTheme,
  importError,
}: ThemesTabProps) {
  return (
    <section className="aya-settings-pane">
      <SettingsHeader icon="palette" title="Themes">
        Terminal color schemes, including imported iTerm2 and Windows
        Terminal themes.
      </SettingsHeader>

      <div className="aya-theme-list">
        {themes.map((t) => (
          <label key={t.id} className="aya-theme-row">
            <input
              type="radio"
              name="active-theme"
              checked={t.id === activeThemeId}
              onChange={() => setActiveTheme(t.id)}
            />
            <ThemeSwatch theme={t} />
            <span className="aya-theme-name">{t.name}</span>
            <button
              className="aya-settings-row-close"
              onClick={() => deleteTheme(t.id)}
              title="Delete this theme"
            >
              ×
            </button>
          </label>
        ))}
        <button className="aya-settings-add" onClick={importTheme}>
          <SettingsIcon name="add" />
          Import theme
        </button>
        {importError && (
          <div className="aya-settings-errors" style={{ marginTop: 8 }}>
            Import failed: {importError}
          </div>
        )}
      </div>
    </section>
  );
}
