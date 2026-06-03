import { useEffect, useState } from "react";
import {
  type CliStatus,
  type HarnessDef,
  type Preset,
  type Snippet,
  type Theme,
  type UsageHookStatus,
  looksNonInteractive,
  presetSlug,
} from "../types";

interface Props {
  presets: Preset[];
  defaults: Preset[];
  snippets: Snippet[];
  themes: Theme[];
  activeThemeId: string;
  onClose: () => void;
  onSave: (presets: Preset[]) => Promise<void> | void;
  onSaveSnippets: (snippets: Snippet[]) => Promise<void> | void;
  onSaveThemes: (
    themes: Theme[],
    activeThemeId: string,
  ) => Promise<void> | void;
  onImportTheme: () => Promise<Theme | null>;
}

// Claude brand color (used for the Claude YOLO preset and as the color placeholder)
const CLAUDE_BRAND_COLOR = "#d97757";
// Preset table column widths (px) kept in sync between header row and body rows
const PRESET_ROW_ICON_WIDTH = 36;
const PRESET_ROW_NAME_WIDTH = 130;
const PRESET_ROW_THEME_WIDTH = 130;
const PRESET_ROW_COLOR_WIDTH = 70;

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

interface DraftSnippet extends Snippet {
  __key: string;
}

function snippetToDraft(c: Snippet): DraftSnippet {
  return { ...c, __key: uuid() };
}

function snippetFromDraft(c: DraftSnippet): Snippet {
  return {
    id: c.id.trim() || presetSlug(c.name || c.text),
    name: c.name,
    text: c.text,
    autoRun: c.autoRun,
  };
}

export function SettingsModal({
  presets,
  defaults,
  snippets,
  themes: initialThemes,
  activeThemeId: initialActiveThemeId,
  onClose,
  onSave,
  onSaveSnippets,
  onSaveThemes,
  onImportTheme,
}: Props) {
  const [draft, setDraft] = useState<DraftPreset[]>(() => presets.map(toDraft));
  const [snippetDraft, setSnippetDraft] = useState<DraftSnippet[]>(() =>
    snippets.map(snippetToDraft),
  );
  const [themes, setThemes] = useState<Theme[]>(initialThemes);
  const [activeThemeId, setActiveThemeId] = useState<string>(
    initialActiveThemeId,
  );
  const [themesDirty, setThemesDirty] = useState(false);
  const [presetsDirty, setPresetsDirty] = useState(false);
  const [snippetsDirty, setSnippetsDirty] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);
  const [usageHook, setUsageHook] = useState<UsageHookStatus | null>(null);
  const [usageHookBusy, setUsageHookBusy] = useState(false);
  const [showUsageConsent, setShowUsageConsent] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(() =>
      typeof Notification === "undefined" ? "default" : Notification.permission,
    );
  // PATH-scan result cached once per modal open. Derived `suggested` below
  // is the not-yet-added subset; recomputed each render against the live
  // draft so a row added via the suggestions immediately drops from the
  // list without waiting for Save.
  const [allHarnesses, setAllHarnesses] = useState<HarnessDef[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.aya.scanHarnesses().then((all) => {
      if (!cancelled) setAllHarnesses(all);
    });
    void window.aya.cliStatus().then((status) => {
      if (!cancelled) setCliStatus(status);
    });
    void window.aya.usageHookStatus().then((status) => {
      if (!cancelled) setUsageHook(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const installCli = async () => {
    setCliInstalling(true);
    try {
      setCliStatus(await window.aya.installCli());
    } finally {
      setCliInstalling(false);
    }
  };

  // Enabling writes a hook + script into ~/.claude (after the consent dialog);
  // disabling removes both. The Aya process itself never reads a token or hits
  // the endpoint — that only happens later in the script, run by Claude Code.
  const enableUsageHook = async () => {
    setShowUsageConsent(false);
    setUsageHookBusy(true);
    try {
      setUsageHook(await window.aya.installUsageHook());
    } finally {
      setUsageHookBusy(false);
    }
  };

  const disableUsageHook = async () => {
    setUsageHookBusy(true);
    try {
      setUsageHook(await window.aya.uninstallUsageHook());
    } finally {
      setUsageHookBusy(false);
    }
  };

  const refreshNotificationPermission = async () => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    } else if (Notification.permission === "denied") {
      await window.aya.openNotificationSettings();
    }
    setNotificationPermission(Notification.permission);
  };

  const existingCmds = new Set(
    draft.map((p) => p.command.trim().toLowerCase()),
  );
  const existingIds = new Set(draft.map((p) => p.id));
  const suggested = allHarnesses.filter(
    (h) =>
      !existingCmds.has(h.command.trim().toLowerCase()) &&
      !existingIds.has(h.id),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Small wrappers that also mark a slice as dirty whenever the user edits its
  // draft, the same way the theme setters call setThemesDirty(true). The dirty
  // flag decides what gets written on Save, and stops an outside edit reloaded
  // from disk from overwriting an edit the user is still working on.
  const editPresets: typeof setDraft = (next) => {
    setDraft(next);
    setPresetsDirty(true);
  };
  const editSnippets: typeof setSnippetDraft = (next) => {
    setSnippetDraft(next);
    setSnippetsDirty(true);
  };

  // When the config watcher reloads a file that was edited by hand while
  // Settings is open, the props change but the drafts we seeded from them
  // don't. Re-sync each slice from props only while the user hasn't touched it,
  // so an outside edit shows up in the modal instead of being overwritten on
  // Save, while a slice the user is editing keeps their draft. These use the
  // plain setters (not the marking wrappers) so the re-sync doesn't mark dirty.
  useEffect(() => {
    if (!presetsDirty) setDraft(presets.map(toDraft));
  }, [presets, presetsDirty]);
  useEffect(() => {
    if (!snippetsDirty) setSnippetDraft(snippets.map(snippetToDraft));
  }, [snippets, snippetsDirty]);
  useEffect(() => {
    if (!themesDirty) {
      setThemes(initialThemes);
      setActiveThemeId(initialActiveThemeId);
    }
  }, [initialThemes, initialActiveThemeId, themesDirty]);

  // --- Presets editor ------------------------------------------------------

  const updateRow = (key: string, patch: Partial<Preset>) => {
    editPresets((prev) =>
      prev.map((p) => (p.__key === key ? { ...p, ...patch } : p)),
    );
  };

  const removeRow = (key: string) => {
    const row = draft.find((p) => p.__key === key);
    if (!row) return;
    if (!confirm(`Remove preset "${row.name || row.id || "(unnamed)"}"?`)) return;
    editPresets((prev) => prev.filter((p) => p.__key !== key));
  };

  const addRow = () => {
    editPresets((prev) => [
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
    editPresets((prev) => [...prev, { __key: uuid(), ...preset }]);
  };

  const addClaudeYolo = () =>
    addPrefilled({
      id: "claude-yolo",
      name: "Claude YOLO",
      icon: "✻",
      color: CLAUDE_BRAND_COLOR,
      command: "claude --dangerously-skip-permissions",
      themeId: undefined,
    });

  /** Add a harness suggestion as a new preset row. */
  const addSuggestion = (h: HarnessDef) =>
    addPrefilled({
      id: h.id,
      name: h.name,
      icon: h.icon,
      color: h.color,
      command: h.command,
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

  // --- Snippets editor -----------------------------------------------------

  const updateSnippetRow = (key: string, patch: Partial<Snippet>) => {
    editSnippets((prev) =>
      prev.map((c) => (c.__key === key ? { ...c, ...patch } : c)),
    );
  };

  const removeSnippetRow = (key: string) => {
    const row = snippetDraft.find((c) => c.__key === key);
    if (!row) return;
    if (!confirm(`Remove snippet "${row.name || row.text || "(unnamed)"}"?`)) {
      return;
    }
    editSnippets((prev) => prev.filter((c) => c.__key !== key));
  };

  const addSnippetRow = () => {
    editSnippets((prev) => [
      ...prev,
      { __key: uuid(), id: "", name: "", text: "", autoRun: false },
    ]);
  };

  const resetPresetsToDefaults = () => {
    if (
      !confirm(
        "Reset all presets to the shipped defaults?\n\nYour custom presets will be lost.",
      )
    ) {
      return;
    }
    editPresets(defaults.map(toDraft));
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

  /** Snippets are lenient: rows with no text are dropped silently (an empty
   *  row is just an in-progress edit, not an error). IDs are de-duplicated. */
  const collectSnippets = (): Snippet[] => {
    const seen = new Set<string>();
    const out: Snippet[] = [];
    for (const row of snippetDraft) {
      const cleaned = snippetFromDraft(row);
      if (!cleaned.text.trim()) continue;
      let id = cleaned.id;
      while (seen.has(id)) id = `${id}-2`;
      seen.add(id);
      out.push({ ...cleaned, id });
    }
    return out;
  };

  const handleSave = async () => {
    const cleaned = validatePresets();
    if (!cleaned) return;
    setSaving(true);
    try {
      // Only write the slices the user actually changed, so an untouched slice
      // that was reloaded from disk is left as-is instead of being rewritten.
      if (presetsDirty) {
        await onSave(cleaned);
      }
      if (snippetsDirty) {
        await onSaveSnippets(collectSnippets());
      }
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
        {showUsageConsent && (
          <div
            className="aya-modal-backdrop"
            style={{ zIndex: 10 }}
            onClick={(e) => {
              e.stopPropagation();
              setShowUsageConsent(false);
            }}
          >
            <div
              className="aya-modal"
              style={{ maxWidth: 460 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="aya-modal-title">Enable the usage chip?</div>
              <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
                This writes a small script and a <code>Stop</code> hook into{" "}
                <code>~/.claude/settings.json</code>. After each Claude Code
                response (throttled to every 5&nbsp;min) the hook queries
                Anthropic&apos;s <strong>undocumented</strong> usage endpoint with
                your own token and saves the result locally for the chip.
                <br />
                <br />
                It is <strong>unsupported</strong> and may change without notice.
                Aya itself never reads your token and never makes the call — that
                happens only in the hook, run by Claude Code. Nothing is sent
                anywhere else. You can turn it off here anytime (it removes both).
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "flex-end",
                  marginTop: 16,
                }}
              >
                <button
                  className="aya-modal-btn"
                  onClick={() => setShowUsageConsent(false)}
                >
                  Cancel
                </button>
                <button
                  className="aya-modal-btn aya-modal-btn--primary"
                  onClick={enableUsageHook}
                >
                  Enable
                </button>
              </div>
            </div>
          </div>
        )}
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

        {/* === General section === */}
        <div className="aya-modal-title">General</div>
        <div className="aya-settings-general">
          <div className="aya-settings-general-row">
            <div>
              <div className="aya-settings-general-title">
                aya command-line tool
              </div>
              <div className="aya-modal-hint">
                {cliStatus?.installed
                  ? `Installed at ${cliStatus.path}`
                  : cliStatus?.message ?? "Not installed"}
              </div>
            </div>
            <button
              className="aya-modal-btn"
              onClick={installCli}
              disabled={cliInstalling}
            >
              {cliInstalling
                ? "Installing..."
                : cliStatus?.installed
                  ? "Reinstall"
                  : "Install"}
            </button>
          </div>
          <div className="aya-settings-general-row">
            <div>
              <div className="aya-settings-general-title">
                Claude usage chip
              </div>
              <div className="aya-modal-hint">
                {usageHook?.installed
                  ? "On — a Claude Code hook updates the account-wide usage chip."
                  : "Off — shows your account-wide Claude limit (5h + weekly) in the title bar."}
              </div>
            </div>
            <button
              className="aya-modal-btn"
              onClick={
                usageHook?.installed
                  ? disableUsageHook
                  : () => setShowUsageConsent(true)
              }
              disabled={usageHookBusy || !usageHook}
            >
              {usageHookBusy
                ? "Working..."
                : usageHook?.installed
                  ? "Disable"
                  : "Enable"}
            </button>
          </div>
          <div className="aya-settings-general-row">
            <div>
              <div className="aya-settings-general-title">Notifications</div>
              <div className="aya-modal-hint">
                macOS permission: {notificationPermission}
              </div>
            </div>
            <button
              className="aya-modal-btn"
              onClick={refreshNotificationPermission}
            >
              {notificationPermission === "denied"
                ? "Open System Settings"
                : notificationPermission === "default"
                  ? "Enable"
                  : "Enabled"}
            </button>
          </div>
        </div>

        <hr className="aya-settings-divider" />

        {/* === Presets section === */}
        <div className="aya-modal-title">Terminal presets</div>
        <div className="aya-modal-hint">
          Each preset is a launcher button in the sidebar. The command runs in
          your shell in the project directory.
        </div>

        <div className="aya-settings-list">
          <div className="aya-settings-row aya-settings-row--head">
            <span style={{ width: PRESET_ROW_ICON_WIDTH }}>Icon</span>
            <span style={{ width: PRESET_ROW_NAME_WIDTH }}>Name</span>
            <span style={{ flex: 1 }}>Command</span>
            <span style={{ width: PRESET_ROW_THEME_WIDTH }}>Theme</span>
            <span style={{ width: PRESET_ROW_COLOR_WIDTH }}>Color</span>
            <span style={{ width: 28 }} />
          </div>
          {draft.map((row) => {
            const warn = looksNonInteractive(row.command);
            return (
              <div className="aya-settings-row" key={row.__key}>
                <input
                  className="aya-modal-input aya-settings-icon-input"
                  style={{ width: PRESET_ROW_ICON_WIDTH }}
                  value={row.icon}
                  maxLength={3}
                  onChange={(e) => updateRow(row.__key, { icon: e.target.value })}
                />
                <input
                  className="aya-modal-input"
                  style={{ width: PRESET_ROW_NAME_WIDTH }}
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
                  style={{ width: PRESET_ROW_THEME_WIDTH }}
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
                  style={{ width: PRESET_ROW_COLOR_WIDTH }}
                  value={row.color}
                  onChange={(e) =>
                    updateRow(row.__key, { color: e.target.value })
                  }
                  placeholder={CLAUDE_BRAND_COLOR}
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

          {suggested.length > 0 && (
            <div className="aya-settings-suggested">
              <div className="aya-settings-section-title">
                Suggested (found on your PATH)
              </div>
              <div className="aya-settings-suggested-row">
                {suggested.map((h) => (
                  <button
                    key={h.id}
                    className="aya-settings-suggested-btn"
                    onClick={() => addSuggestion(h)}
                    title={h.command}
                    style={h.color ? { borderColor: h.color } : undefined}
                  >
                    <span
                      className="aya-settings-suggested-icon"
                      style={h.color ? { color: h.color } : undefined}
                    >
                      {h.icon}
                    </span>
                    <span>＋ {h.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {errors.length > 0 && (
          <div className="aya-settings-errors">
            {errors.map((e, i) => (
              <div key={i}>• {e}</div>
            ))}
          </div>
        )}

        <hr className="aya-settings-divider" />

        {/* === Snippets section === */}
        <div className="aya-modal-title">Snippets</div>
        <div className="aya-modal-hint">
          Saved text you can inject into the active terminal from its snippet
          drawer (the <strong>snippets</strong> button in a pane header). Toggle{" "}
          <span className="aya-snippet-inline-ico" style={{ color: "#56d364" }}>
            ▶
          </span>{" "}
          to run on send (adds Enter), or{" "}
          <span className="aya-snippet-inline-ico" style={{ color: "#e3b341" }}>
            ⏸
          </span>{" "}
          to only type it (you press Enter). Lives in Aya, not in an agent's
          context.
        </div>

        <div className="aya-settings-list">
          {snippetDraft.map((row) => (
            <div className="aya-settings-snippet-row" key={row.__key}>
              <button
                type="button"
                className={`aya-snippet-runtoggle aya-snippet-runtoggle--${
                  row.autoRun ? "run" : "hold"
                }`}
                onClick={() =>
                  updateSnippetRow(row.__key, { autoRun: !row.autoRun })
                }
                title={
                  row.autoRun
                    ? "Runs on send (Enter appended) — click to switch to type-only"
                    : "Types only (you press Enter) — click to switch to run-on-send"
                }
              >
                <span style={{ fontFamily: "Material Symbols Outlined" }}>
                  {row.autoRun ? "play_arrow" : "pause"}
                </span>
              </button>
              <div className="aya-settings-snippet-fields">
                <input
                  className="aya-modal-input aya-settings-snippet-name"
                  value={row.name}
                  onChange={(e) =>
                    updateSnippetRow(row.__key, { name: e.target.value })
                  }
                  placeholder="Label (e.g. npm test)"
                />
                <textarea
                  className="aya-modal-input aya-settings-snippet-text"
                  value={row.text}
                  rows={Math.min(6, Math.max(1, row.text.split("\n").length))}
                  onChange={(e) =>
                    updateSnippetRow(row.__key, { text: e.target.value })
                  }
                  placeholder="Text sent to the terminal (shell command or agent prompt)"
                  spellCheck={false}
                />
              </div>
              <button
                className="aya-settings-row-close"
                onClick={() => removeSnippetRow(row.__key)}
                title="Remove snippet"
              >
                ×
              </button>
            </div>
          ))}
          <div className="aya-settings-add-row">
            <button className="aya-settings-add" onClick={addSnippetRow}>
              ＋ Add snippet
            </button>
          </div>
        </div>

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
