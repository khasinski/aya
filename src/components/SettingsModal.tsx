import { useEffect, useState } from "react";
import {
  type Preset,
  type Theme,
  looksNonInteractive,
  presetSlug,
} from "../types";

interface Props {
  presets: Preset[];
  defaults: Preset[];
  themes: Theme[];
  activeThemeId: string;
  onClose: () => void;
  onSave: (presets: Preset[]) => Promise<void> | void;
  onSaveThemes: (
    themes: Theme[],
    activeThemeId: string,
  ) => Promise<void> | void;
  onImportTheme: () => Promise<Theme | null>;
}

function uuid(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface DraftPreset extends Preset {
  __key: string;
}

function toDraft(p: Preset): DraftPreset {
  return { ...p, __key: uuid() };
}

function fromDraft(p: DraftPreset): Preset {
  const id = p.id.trim() || presetSlug(p.name);
  const themeId = p.themeId && p.themeId.trim() ? p.themeId : undefined;
  return {
    id,
    name: p.name,
    icon: p.icon,
    color: p.color,
    command: p.command,
    ...(themeId ? { themeId } : {}),
  };
}

export function SettingsModal({
  presets,
  defaults,
  themes: initialThemes,
  activeThemeId: initialActiveThemeId,
  onClose,
  onSave,
  onSaveThemes,
  onImportTheme,
}: Props) {
  const [draft, setDraft] = useState<DraftPreset[]>(() => presets.map(toDraft));
  const [themes, setThemes] = useState<Theme[]>(initialThemes);
  const [activeThemeId, setActiveThemeId] = useState<string>(
    initialActiveThemeId,
  );
  const [themesDirty, setThemesDirty] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // --- Presets editor ------------------------------------------------------

  const updateRow = (key: string, patch: Partial<Preset>) => {
    setDraft((prev) =>
      prev.map((p) => (p.__key === key ? { ...p, ...patch } : p)),
    );
  };

  const removeRow = (key: string) => {
    const row = draft.find((p) => p.__key === key);
    if (!row) return;
    if (!confirm(`Remove preset "${row.name || row.id || "(unnamed)"}"?`)) return;
    setDraft((prev) => prev.filter((p) => p.__key !== key));
  };

  const addRow = () => {
    setDraft((prev) => [
      ...prev,
      {
        __key: uuid(),
        id: "",
        name: "",
        icon: "•",
        color: "",
        command: "",
        themeId: undefined,
      },
    ]);
  };

  /** Append a pre-filled preset. Used by the YOLO quick-add buttons. */
  const addPrefilled = (preset: Omit<DraftPreset, "__key">) => {
    setDraft((prev) => [...prev, { __key: uuid(), ...preset }]);
  };

  const addClaudeYolo = () =>
    addPrefilled({
      id: "claude-yolo",
      name: "Claude YOLO",
      icon: "✻",
      color: "#d97757",
      command: "claude --dangerously-skip-permissions",
      themeId: undefined,
    });

  const addCodexYolo = () =>
    addPrefilled({
      id: "codex-yolo",
      name: "Codex YOLO",
      icon: "◆",
      color: "#10a37f",
      command: "codex --dangerously-bypass-approvals-and-sandbox",
      themeId: undefined,
    });

  const resetPresetsToDefaults = () => {
    if (
      !confirm(
        "Reset all presets to the shipped defaults?\n\nYour custom presets will be lost.",
      )
    ) {
      return;
    }
    setDraft(defaults.map(toDraft));
  };

  const validatePresets = (): Preset[] | null => {
    const errs: string[] = [];
    const seen = new Set<string>();
    const out: Preset[] = [];
    for (const row of draft) {
      const cleaned = fromDraft(row);
      if (!cleaned.name.trim()) {
        errs.push("Every preset needs a name.");
        continue;
      }
      if (!cleaned.command.trim()) {
        errs.push(`Preset "${cleaned.name}" has no command.`);
        continue;
      }
      if (seen.has(cleaned.id)) {
        errs.push(`Duplicate id "${cleaned.id}". Rename one.`);
        continue;
      }
      seen.add(cleaned.id);
      out.push(cleaned);
    }
    if (out.length === 0) {
      errs.push("Keep at least one preset.");
    }
    setErrors(errs);
    return errs.length === 0 ? out : null;
  };

  // --- Themes editor -------------------------------------------------------

  const setActiveTheme = (id: string) => {
    setActiveThemeId(id);
    setThemesDirty(true);
  };

  const deleteTheme = (id: string) => {
    const t = themes.find((x) => x.id === id);
    if (!t) return;
    if (!confirm(`Delete theme "${t.name}"?`)) return;
    const next = themes.filter((x) => x.id !== id);
    setThemes(next);
    if (activeThemeId === id) {
      setActiveThemeId(next[0]?.id ?? "");
    }
    setThemesDirty(true);
  };

  const importTheme = async () => {
    setImportError(null);
    try {
      const imported = await onImportTheme();
      if (!imported) return;
      const next = [...themes, imported];
      setThemes(next);
      setActiveThemeId(imported.id);
      setThemesDirty(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  // --- Save ---------------------------------------------------------------

  const handleSave = async () => {
    const cleaned = validatePresets();
    if (!cleaned) return;
    setSaving(true);
    try {
      await onSave(cleaned);
      if (themesDirty) {
        await onSaveThemes(themes, activeThemeId);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="aya-modal-backdrop" onClick={onClose}>
      <div
        className="aya-modal aya-modal--settings"
        onClick={(e) => e.stopPropagation()}
      >
        {/* === Theme section === */}
        <div className="aya-modal-title">Terminal theme</div>
        <div className="aya-modal-hint">
          Color scheme for all terminals. Import iTerm2 <code>.itermcolors</code>{" "}
          or Windows Terminal JSON files — both are converted to xterm.js's
          native format internally.
        </div>

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
            ＋ Import theme (.itermcolors / .json)
          </button>
          {importError && (
            <div className="aya-settings-errors" style={{ marginTop: 8 }}>
              Import failed: {importError}
            </div>
          )}
        </div>

        <hr className="aya-settings-divider" />

        {/* === Presets section === */}
        <div className="aya-modal-title">Terminal presets</div>
        <div className="aya-modal-hint">
          Each preset is a launcher button in the sidebar. The command runs
          inside <code>bash -lc</code> in the project directory.
        </div>

        <div className="aya-settings-list">
          <div className="aya-settings-row aya-settings-row--head">
            <span style={{ width: 36 }}>Icon</span>
            <span style={{ width: 130 }}>Name</span>
            <span style={{ flex: 1 }}>Command</span>
            <span style={{ width: 130 }}>Theme</span>
            <span style={{ width: 70 }}>Color</span>
            <span style={{ width: 28 }} />
          </div>
          {draft.map((row) => {
            const warn = looksNonInteractive(row.command);
            return (
              <div className="aya-settings-row" key={row.__key}>
                <input
                  className="aya-modal-input aya-settings-icon-input"
                  style={{ width: 36 }}
                  value={row.icon}
                  maxLength={3}
                  onChange={(e) => updateRow(row.__key, { icon: e.target.value })}
                />
                <input
                  className="aya-modal-input"
                  style={{ width: 130 }}
                  value={row.name}
                  onChange={(e) => updateRow(row.__key, { name: e.target.value })}
                  placeholder="Display name"
                />
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <input
                    className="aya-modal-input"
                    value={row.command}
                    onChange={(e) =>
                      updateRow(row.__key, { command: e.target.value })
                    }
                    placeholder="e.g. claude   or   aider --dark   or   $SHELL"
                    spellCheck={false}
                  />
                  {warn && (
                    <span className="aya-settings-warn">
                      ⚠ Looks like a non-interactive flag. Claude requires
                      interactive mode for subscription billing — double-check.
                    </span>
                  )}
                </div>
                <select
                  className="aya-modal-input"
                  style={{ width: 130 }}
                  value={row.themeId ?? ""}
                  onChange={(e) =>
                    updateRow(row.__key, {
                      themeId: e.target.value || undefined,
                    })
                  }
                  title="Per-preset theme override (empty = use default)"
                >
                  <option value="">Default</option>
                  {themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <input
                  className="aya-modal-input"
                  style={{ width: 70 }}
                  value={row.color}
                  onChange={(e) =>
                    updateRow(row.__key, { color: e.target.value })
                  }
                  placeholder="#d97757"
                  spellCheck={false}
                />
                <button
                  className="aya-settings-row-close"
                  onClick={() => removeRow(row.__key)}
                  title="Remove preset"
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="aya-settings-add-row">
            <button className="aya-settings-add" onClick={addRow}>
              ＋ Add preset
            </button>
            <button
              className="aya-settings-add aya-settings-add--yolo"
              onClick={addClaudeYolo}
              title="claude --dangerously-skip-permissions"
            >
              ＋ Claude YOLO
            </button>
            <button
              className="aya-settings-add aya-settings-add--yolo"
              onClick={addCodexYolo}
              title="codex --dangerously-bypass-approvals-and-sandbox"
            >
              ＋ Codex YOLO
            </button>
          </div>
        </div>

        {errors.length > 0 && (
          <div className="aya-settings-errors">
            {errors.map((e, i) => (
              <div key={i}>• {e}</div>
            ))}
          </div>
        )}

        <div className="aya-modal-actions aya-settings-actions">
          <button className="aya-modal-btn" onClick={resetPresetsToDefaults}>
            Reset presets to defaults
          </button>
          <div style={{ flex: 1 }} />
          <button className="aya-modal-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A tiny inline strip of the theme's six most distinctive colors so the user
 *  can spot themes at a glance without picking each one. */
function ThemeSwatch({ theme }: { theme: Theme }) {
  const { background, foreground, red, green, blue, magenta } = theme.colors;
  return (
    <span
      className="aya-theme-swatch"
      title={`${theme.name}`}
      style={{ background }}
    >
      <span style={{ background: foreground }} />
      <span style={{ background: red }} />
      <span style={{ background: green }} />
      <span style={{ background: blue }} />
      <span style={{ background: magenta }} />
    </span>
  );
}
