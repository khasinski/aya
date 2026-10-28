import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { inferAgent } from "../../agentPreset";
import { uuid } from "../../uuid";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../../colors";
import type { HarnessDef, Preset, Snippet, Theme } from "../../types";
import {
  DEFAULT_CLAUDE_CONFIG_DIR,
  DEFAULT_CODEX_CONFIG_DIR,
  agentCommand,
  fromDraft,
  snippetFromDraft,
  snippetToDraft,
  toDraft,
  type DraftPreset,
  type DraftSnippet,
} from "./drafts";

/** The Presets, Snippets and Themes drafts Settings edits, and the Save that writes only the slices the user changed. */
export function useSettingsDrafts({
  presets,
  defaults,
  snippets,
  initialThemes,
  initialActiveThemeId,
  onSave,
  onSaveSnippets,
  onSaveThemes,
  onImportTheme,
  onClose,
  setActiveTab,
}: {
  presets: Preset[];
  defaults: Preset[];
  snippets: Snippet[];
  initialThemes: Theme[];
  initialActiveThemeId: string;
  onSave: (presets: Preset[]) => Promise<void> | void;
  onSaveSnippets: (snippets: Snippet[]) => Promise<void> | void;
  onSaveThemes: (themes: Theme[], activeThemeId: string) => Promise<void> | void;
  onImportTheme: () => Promise<Theme | null>;
  onClose: () => void;
  setActiveTab: Dispatch<SetStateAction<any>>;
}) {
  const [draft, setDraft] = useState<DraftPreset[]>(() => presets.map(toDraft));
  const [activePresetKey, setActivePresetKey] = useState<string | null>(null);
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
  const [snippetsSaveError, setSnippetsSaveError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
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
    if (draft.length === 0) {
      if (activePresetKey !== null) setActivePresetKey(null);
      return;
    }
    if (!activePresetKey || !draft.some((p) => p.__key === activePresetKey)) {
      setActivePresetKey(draft[0].__key);
    }
  }, [activePresetKey, draft]);
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

  const updateAgentFields = (
    key: string,
    patch: Partial<Pick<Preset, "agent" | "configDir" | "unsafeMode">>,
  ) => {
    editPresets((prev) =>
      prev.map((p) => {
        if (p.__key !== key) return p;
        const next = { ...p, ...patch };
        if (next.agent === "claude" || next.agent === "codex") {
          const configDir =
            next.configDir ||
            (next.agent === "claude"
              ? DEFAULT_CLAUDE_CONFIG_DIR
              : DEFAULT_CODEX_CONFIG_DIR);
          return {
            ...next,
            configDir,
            command: agentCommand(next.agent, configDir, next.unsafeMode),
          };
        }
        return {
          ...next,
          agent: "custom",
          configDir: undefined,
          unsafeMode: undefined,
        };
      }),
    );
  };

  const removeRow = (key: string) => {
    const row = draft.find((p) => p.__key === key);
    if (!row) return;
    if (!confirm(`Remove preset "${row.name || row.id || "(unnamed)"}"?`)) return;
    editPresets((prev) => prev.filter((p) => p.__key !== key));
  };

  const addRow = () => {
    const key = uuid();
    editPresets((prev) => [
      ...prev,
      {
        __key: key,
        id: "",
        name: "",
        icon: "•",
        color: "",
        command: "",
        agent: "custom",
        autoResume: false,
        themeId: undefined,
      },
    ]);
    setActivePresetKey(key);
  };

  /** Append a pre-filled preset. */
  const addPrefilled = (preset: Omit<DraftPreset, "__key">) => {
    const key = uuid();
    editPresets((prev) => [...prev, { __key: key, ...preset }]);
    setActivePresetKey(key);
  };

  const addClaudeAccount = () =>
    addPrefilled({
      id: "",
      name: "Claude Account",
      icon: "✻",
      color: CLAUDE_BRAND_COLOR,
      command: agentCommand("claude", DEFAULT_CLAUDE_CONFIG_DIR, false),
      agent: "claude",
      configDir: DEFAULT_CLAUDE_CONFIG_DIR,
      autoResume: true,
      themeId: undefined,
    });

  /** Add a harness suggestion as a new preset row. */
  const addSuggestion = (h: HarnessDef) => {
    // Inferred, not "custom": an explicit custom hides the brief toggle and
    // auto-resume for every agent CLI but claude and codex.
    const agent = inferAgent({ command: h.command });
    const configDir =
      agent === "claude"
        ? DEFAULT_CLAUDE_CONFIG_DIR
        : agent === "codex"
          ? DEFAULT_CODEX_CONFIG_DIR
          : undefined;
    addPrefilled({
      id: h.id,
      name: h.name,
      icon: h.icon,
      color: h.color,
      command: configDir ? agentCommand(agent, configDir, false) : h.command,
      agent,
      configDir,
      autoResume: agent !== "custom",
      themeId: undefined,
    });
  };

  const addCodexAccount = () =>
    addPrefilled({
      id: "",
      name: "Codex Account",
      icon: "◆",
      color: CODEX_BRAND_COLOR,
      command: agentCommand("codex", DEFAULT_CODEX_CONFIG_DIR, false),
      agent: "codex",
      configDir: DEFAULT_CODEX_CONFIG_DIR,
      autoResume: true,
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
        try {
          await onSaveSnippets(collectSnippets());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setSnippetsSaveError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
          setActiveTab("snippets");
          return;
        }
      }
      if (themesDirty) {
        await onSaveThemes(themes, activeThemeId);
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return { draft, setDraft, activePresetKey, setActivePresetKey, snippetDraft, setSnippetDraft, themes, setThemes, activeThemeId, setActiveThemeId, themesDirty, setThemesDirty, presetsDirty, setPresetsDirty, snippetsDirty, setSnippetsDirty, snippetsSaveError, setSnippetsSaveError, importError, setImportError, saving, setSaving, errors, setErrors, editPresets, editSnippets, updateRow, updateAgentFields, removeRow, addRow, addPrefilled, addClaudeAccount, addSuggestion, addCodexAccount, updateSnippetRow, removeSnippetRow, addSnippetRow, resetPresetsToDefaults, validatePresets, setActiveTheme, deleteTheme, importTheme, collectSnippets, handleSave };
}
