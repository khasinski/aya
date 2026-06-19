import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../colors";
import { useEffect, useState, type ReactNode } from "react";
import {
  type CliStatus,
  type HarnessDef,
  type MicPermissionStatus,
  type Preset,
  type Snippet,
  type Theme,
  type UsageHookStatus,
  looksNonInteractive,
  presetSlug,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import type { MacOptionKeyMode } from "../terminal-option-key";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";

const DEFAULT_CLAUDE_CONFIG_DIR = "~/.claude";
const DEFAULT_CODEX_CONFIG_DIR = "~/.codex";

interface Props {
  presets: Preset[];
  defaults: Preset[];
  snippets: Snippet[];
  themes: Theme[];
  activeThemeId: string;
  appThemePreference: "system" | "light" | "dark";
  onAppThemePreferenceChange: (theme: "system" | "light" | "dark") => void;
  terminalFontFamily: string;
  onTerminalFontFamilyChange: (fontFamily: string) => void;
  showUsageHarnessName: boolean;
  onShowUsageHarnessNameChange: (show: boolean) => void;
  macOptionKeyMode: MacOptionKeyMode;
  onMacOptionKeyModeChange: (mode: MacOptionKeyMode) => void;
  onClose: () => void;
  onSave: (presets: Preset[]) => Promise<void> | void;
  onSaveSnippets: (snippets: Snippet[]) => Promise<void> | void;
  onSaveThemes: (
    themes: Theme[],
    activeThemeId: string,
  ) => Promise<void> | void;
  onImportTheme: () => Promise<Theme | null>;
  /** Restart the detached PTY host (#28). Kills running terminals, so the
   *  button confirms first. */
  onRestartPtyHost: () => Promise<void> | void;
  initialTab?: SettingsTab;
}

function uuid(): string {
  return Math.random().toString(36).slice(2, 10);
}

interface DraftPreset extends Preset {
  __key: string;
}

function toDraft(p: Preset): DraftPreset {
  const agent = p.agent ?? inferAgent(p);
  const isAgent = agent === "claude" || agent === "codex";
  return {
    ...p,
    agent,
    configDir: p.configDir ?? inferConfigDir(p.command, agent),
    unsafeMode: p.unsafeMode ?? inferUnsafeMode(p.command, agent),
    autoResume: p.autoResume ?? isAgent,
    __key: uuid(),
  };
}

function fromDraft(p: DraftPreset): Preset {
  const id = p.id.trim() || presetSlug(p.name);
  const themeId = p.themeId && p.themeId.trim() ? p.themeId : undefined;
  const agent = p.agent;
  const configDir =
    p.configDir && p.configDir.trim() ? p.configDir.trim() : undefined;
  return {
    id,
    name: p.name,
    icon: p.icon,
    color: p.color,
    command: p.command,
    ...(agent ? { agent } : {}),
    ...(configDir ? { configDir } : {}),
    ...(p.unsafeMode ? { unsafeMode: true } : {}),
    ...(p.autoResume ? { autoResume: true } : {}),
    ...(themeId ? { themeId } : {}),
  };
}

function inferAgent(p: Preset): Preset["agent"] {
  const command = p.command.trim();
  if (/\bCLAUDE_CONFIG_DIR=/.test(command) || /^claude(?:\s|$)/.test(command)) {
    return "claude";
  }
  if (/\bCODEX_HOME=/.test(command) || /^codex(?:\s|$)/.test(command)) {
    return "codex";
  }
  return "custom";
}

function inferConfigDir(command: string, agent: Preset["agent"]): string | undefined {
  const key =
    agent === "claude"
      ? "CLAUDE_CONFIG_DIR"
      : agent === "codex"
        ? "CODEX_HOME"
        : null;
  if (!key) return undefined;
  const value = command.match(new RegExp(`(?:^|\\s)${key}=("[^"]*"|'[^']*'|\\S+)`))?.[1];
  if (!value) return undefined;
  const unquoted = value.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
  return unquoted.replace(/^\$HOME(?=\/|$)/, "~");
}

function inferUnsafeMode(command: string, agent: Preset["agent"]): boolean {
  if (agent === "claude") {
    return /\s--dangerously-skip-permissions(?:\s|$)/.test(` ${command} `);
  }
  if (agent === "codex") {
    return /\s(?:--dangerously-bypass-approvals-and-sandbox|--yolo)(?:\s|$)/.test(
      ` ${command} `,
    );
  }
  return false;
}

function quoteEnv(value: string): string {
  const trimmed = value.trim();
  if (/^~(?=\/|$)/.test(trimmed)) {
    const suffix = trimmed.slice(1).replace(/(["\\$`])/g, "\\$1");
    return `"$HOME${suffix}"`;
  }
  return `"${trimmed.replace(/(["\\$`])/g, "\\$1")}"`;
}

function isDefaultAgentConfigDir(
  agent: Preset["agent"],
  configDir: string | undefined,
): boolean {
  const trimmed = configDir?.trim();
  if (!trimmed) return true;
  if (agent === "claude") {
    return trimmed === DEFAULT_CLAUDE_CONFIG_DIR || trimmed === "$HOME/.claude";
  }
  if (agent === "codex") {
    return trimmed === DEFAULT_CODEX_CONFIG_DIR || trimmed === "$HOME/.codex";
  }
  return false;
}

function agentCommand(
  agent: Preset["agent"],
  configDir: string | undefined,
  unsafeMode: boolean | undefined,
): string {
  if (agent === "claude") {
    const base = configDir?.trim() && !isDefaultAgentConfigDir(agent, configDir)
      ? `CLAUDE_CONFIG_DIR=${quoteEnv(configDir)} claude`
      : "claude";
    return unsafeMode ? `${base} --dangerously-skip-permissions` : base;
  }
  if (agent === "codex") {
    const base = configDir?.trim() && !isDefaultAgentConfigDir(agent, configDir)
      ? `CODEX_HOME=${quoteEnv(configDir)} codex`
      : "codex";
    return unsafeMode ? `${base} --dangerously-bypass-approvals-and-sandbox` : base;
  }
  return "";
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

function SettingsIcon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      className={`aya-settings-material ${className}`}
      style={{ fontFamily: "Material Symbols Outlined" }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

function SettingsHeader({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="aya-settings-header">
      <div className="aya-settings-header-icon">
        <SettingsIcon name={icon} />
      </div>
      <div>
        <div className="aya-modal-title">{title}</div>
        {children && <div className="aya-modal-hint">{children}</div>}
      </div>
    </div>
  );
}

function SettingsRow({
  icon,
  title,
  children,
  control,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="aya-settings-general-row">
      <div className="aya-settings-general-copy">
        <div className="aya-settings-row-icon">
          <SettingsIcon name={icon} />
        </div>
        <div>
          <div className="aya-settings-general-title">{title}</div>
          {children && <div className="aya-modal-hint">{children}</div>}
        </div>
      </div>
      <div className="aya-settings-control">{control}</div>
    </div>
  );
}

export function SettingsModal({
  presets,
  defaults,
  snippets,
  themes: initialThemes,
  activeThemeId: initialActiveThemeId,
  appThemePreference,
  onAppThemePreferenceChange,
  terminalFontFamily,
  onTerminalFontFamilyChange,
  showUsageHarnessName,
  onShowUsageHarnessNameChange,
  macOptionKeyMode,
  onMacOptionKeyModeChange,
  onClose,
  onSave,
  onSaveSnippets,
  onSaveThemes,
  onImportTheme,
  onRestartPtyHost,
  initialTab = "general",
}: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
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
  const [micStatus, setMicStatus] = useState<MicPermissionStatus | null>(null);
  const [micBusy, setMicBusy] = useState(false);
  // PATH-scan result cached once per modal open. Derived `suggested` below
  // is the not-yet-added subset; recomputed each render against the live
  // draft so a row added via the suggestions immediately drops from the
  // list without waiting for Save.
  const [allHarnesses, setAllHarnesses] = useState<HarnessDef[]>([]);
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

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
    void window.aya.micStatus().then((status) => {
      if (!cancelled) setMicStatus(status);
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

  // Aya never records; CLI tools the user runs (e.g. a /voice plugin) may. macOS
  // owns the grant: when undecided we trigger its prompt, otherwise we deep-link
  // to System Settings where the user can grant or revoke. We only re-read the
  // status — we never claim to toggle it ourselves.
  const handleMicAction = async () => {
    setMicBusy(true);
    try {
      if (micStatus === "not-determined") {
        await window.aya.requestMicAccess();
      } else {
        await window.aya.openMicrophoneSettings();
      }
      setMicStatus(await window.aya.micStatus());
    } finally {
      setMicBusy(false);
    }
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
    const agent = h.id === "claude" || h.id === "codex" ? h.id : "custom";
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
      autoResume: agent === "claude" || agent === "codex",
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

  const tabItems: Array<{
    id: SettingsTab;
    label: string;
    icon: string;
    dirty: boolean;
  }> = [
    { id: "general", label: "General", icon: "tune", dirty: false },
    { id: "themes", label: "Themes", icon: "palette", dirty: themesDirty },
    { id: "presets", label: "Presets", icon: "terminal", dirty: presetsDirty },
    { id: "snippets", label: "Snippets", icon: "bolt", dirty: snippetsDirty },
  ];
  const activePreset = draft.find((p) => p.__key === activePresetKey) ?? draft[0];

  return (
    <div
      className="aya-modal-backdrop"
      onMouseDown={markBackdropMouseDown}
      onClick={(e) => closeFromBackdropClick(e, onClose)}
    >
      <div
        className="aya-modal aya-modal--settings"
        onClick={(e) => e.stopPropagation()}
      >
        {showUsageConsent && (
          <div
            className="aya-modal-backdrop"
            style={{ zIndex: 10 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              markBackdropMouseDown(e);
            }}
            onClick={(e) => {
              e.stopPropagation();
              closeFromBackdropClick(e, () => setShowUsageConsent(false));
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
        <div className="aya-settings-chrome">
          <div className="aya-settings-toolbar" role="tablist" aria-label="Settings">
            {tabItems.map((item) => (
              <button
                key={item.id}
                data-testid="settings-tab"
                type="button"
                role="tab"
                aria-selected={activeTab === item.id}
                className={`aya-settings-tab ${
                  activeTab === item.id ? "aya-settings-tab--active" : ""
                }`}
                onClick={() => setActiveTab(item.id)}
              >
                <span className="aya-settings-tab-icon">
                  <SettingsIcon name={item.icon} />
                </span>
                <span>{item.label}</span>
                {item.dirty && <span className="aya-settings-tab-dirty" />}
              </button>
            ))}
          </div>

          <div className="aya-settings-pane-shell">
            {activeTab === "themes" && (
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
            )}

            {activeTab === "general" && (
              <section className="aya-settings-pane">
                <SettingsHeader icon="tune" title="General" />
                <div className="aya-settings-general">
          <SettingsRow
            icon="contrast"
            title="Appearance"
            control={(
              <div className="aya-settings-segmented" aria-label="Appearance">
              {(["system", "light", "dark"] as const).map((theme) => (
                <button
                  key={theme}
                  data-testid="appearance-segment"
                  type="button"
                  className={`aya-settings-segment ${
                    appThemePreference === theme
                      ? "aya-settings-segment--active"
                      : ""
                  }`}
                  onClick={() => onAppThemePreferenceChange(theme)}
                >
                  {theme === "system"
                    ? "System"
                    : theme === "light"
                      ? "Light"
                      : "Dark"}
                </button>
              ))}
            </div>
            )}
          >
            Follow system appearance or pin Aya.
          </SettingsRow>
          <SettingsRow
            icon="text_fields"
            title="Terminal font"
            control={(
              <input
                className="aya-modal-input"
                style={{ width: 320 }}
                value={terminalFontFamily}
                onChange={(e) => onTerminalFontFamilyChange(e.target.value)}
                placeholder={'"Berkeley Mono", monospace'}
                spellCheck={false}
              />
            )}
          >
            Leave empty to use Aya's default terminal font.
          </SettingsRow>
          <SettingsRow
            icon="keyboard_option_key"
            title="Mac Option key"
            control={(
              <div className="aya-settings-segmented" aria-label="Mac Option key">
              {([
                ["right-option-compose", "Right Option composes"],
                ["option-as-meta", "All Option = Meta"],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  data-testid="mac-option-segment"
                  type="button"
                  className={`aya-settings-segment ${
                    macOptionKeyMode === mode
                      ? "aya-settings-segment--active"
                      : ""
                  }`}
                  onClick={() => onMacOptionKeyModeChange(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            )}
          >
            Left Option as Meta, right Option for accents.
          </SettingsRow>
          <SettingsRow
            icon="terminal"
            title="aya command-line tool"
            control={(
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
            )}
          >
            {cliStatus?.message ??
              (cliStatus?.installed
                ? `Installed at ${cliStatus.path}`
                : "Not installed")}
          </SettingsRow>
          <SettingsRow
            icon="restart_alt"
            title="PTY host"
            control={(
              <button
                className="aya-modal-btn"
                onClick={() => {
                  if (
                    confirm(
                      "Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.",
                    )
                  ) {
                    void onRestartPtyHost();
                  }
                }}
              >
                Restart
              </button>
            )}
          >
            Restarts the background terminal host. Use after an update if
            terminals behave like an older version.
          </SettingsRow>
          <SettingsRow
            icon="donut_large"
            title="Display harness name in usage icons"
            control={(
              <div className="aya-settings-segmented" aria-label="Usage icons">
                {([
                  [true, "Show names"],
                  [false, "Compact rings"],
                ] as const).map(([show, label]) => (
                  <button
                    key={String(show)}
                    type="button"
                    className={`aya-settings-segment ${
                      showUsageHarnessName === show
                        ? "aya-settings-segment--active"
                        : ""
                    }`}
                    onClick={() => onShowUsageHarnessNameChange(show)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          >
            Show Claude/Codex names in the top-bar usage icons, or use compact
            progress rings.
          </SettingsRow>
          <SettingsRow
            icon="donut_large"
            title="Claude usage chip"
            control={(
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
            )}
          >
            {usageHook?.installed
              ? "On. Updated by a Claude Code hook."
              : "Off. Shows account-wide Claude limits."}
          </SettingsRow>
          <SettingsRow
            icon="notifications"
            title="Notifications"
            control={(
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
            )}
          >
            macOS permission: {notificationPermission}
          </SettingsRow>
          {micStatus && micStatus !== "unsupported" && (
            <SettingsRow
              icon="mic"
              title="Microphone"
              control={(
                <button
                  className="aya-modal-btn"
                  onClick={handleMicAction}
                  disabled={micBusy}
                >
                  {micBusy
                    ? "Working..."
                    : micStatus === "not-determined"
                      ? "Allow…"
                      : micStatus === "granted"
                        ? "Manage"
                        : "Open System Settings"}
                </button>
              )}
            >
              Aya never records. Used only by terminal tools you run (e.g. a
              /voice plugin). macOS permission: {micStatus}
            </SettingsRow>
          )}
                </div>
              </section>
            )}

            {activeTab === "presets" && (
              <section className="aya-settings-pane">
                <SettingsHeader icon="terminal" title="Presets">
                  Sidebar launchers for shells and agent CLIs. Use multiple
                  Claude or Codex accounts by giving each one its own config
                  directory.
                </SettingsHeader>

                <div className="aya-settings-list aya-settings-presets">
          <div className="aya-settings-add-row">
            <button className="aya-settings-add" onClick={addClaudeAccount}>
              <SettingsIcon name="add" />
              Add Claude
            </button>
            <button className="aya-settings-add" onClick={addCodexAccount}>
              <SettingsIcon name="add" />
              Add Codex
            </button>
            <button className="aya-settings-add" onClick={addRow}>
              <SettingsIcon name="add" />
              Add custom
            </button>
          </div>

          {draft.length > 0 && (
            <div className="aya-preset-selector">
              <div
                className="aya-preset-tabs"
                role="tablist"
                aria-label="Presets"
              >
                {draft.map((row) => (
                  <button
                    key={row.__key}
                    type="button"
                    role="tab"
                    aria-selected={row.__key === activePreset?.__key}
                    className={`aya-preset-tab ${
                      row.__key === activePreset?.__key
                        ? "aya-preset-tab--active"
                        : ""
                    }`}
                    onClick={() => setActivePresetKey(row.__key)}
                    title={row.name || row.command || "Untitled preset"}
                  >
                    <span
                      className="aya-preset-tab-icon"
                      style={row.color ? { color: row.color } : undefined}
                    >
                      {row.icon || "•"}
                    </span>
                    <span className="aya-preset-tab-name">
                      {row.name || "Untitled"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activePreset &&
            (() => {
              const row = activePreset;
              const warn = looksNonInteractive(row.command);
              const isAgent = row.agent === "claude" || row.agent === "codex";
              return (
              <div className="aya-preset-card" key={row.__key}>
                <div className="aya-preset-section">
                  <div className="aya-settings-section-title">Command</div>
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

                <div className="aya-preset-section">
                  <div className="aya-settings-section-title">Account</div>
                  <div className="aya-preset-grid aya-preset-grid--account">
                    <label>
                      <span>Type</span>
                      <select
                        className="aya-modal-input"
                        value={row.agent ?? "custom"}
                        onChange={(e) => {
                          const agent = e.target.value as Preset["agent"];
                          if (agent === "claude") {
                            updateRow(row.__key, {
                              agent,
                              icon: row.icon || "✻",
                              color: row.color || CLAUDE_BRAND_COLOR,
                              configDir:
                                row.configDir || DEFAULT_CLAUDE_CONFIG_DIR,
                              command: agentCommand(
                                agent,
                                row.configDir || DEFAULT_CLAUDE_CONFIG_DIR,
                                row.unsafeMode,
                              ),
                              autoResume: row.autoResume ?? true,
                            });
                          } else if (agent === "codex") {
                            updateRow(row.__key, {
                              agent,
                              icon: row.icon || "◆",
                              color: row.color || CODEX_BRAND_COLOR,
                              configDir:
                                row.configDir || DEFAULT_CODEX_CONFIG_DIR,
                              command: agentCommand(
                                agent,
                                row.configDir || DEFAULT_CODEX_CONFIG_DIR,
                                row.unsafeMode,
                              ),
                              autoResume: row.autoResume ?? true,
                            });
                          } else {
                            updateAgentFields(row.__key, { agent: "custom" });
                          }
                        }}
                      >
                        <option value="claude">Claude</option>
                        <option value="codex">Codex</option>
                        <option value="custom">Custom</option>
                      </select>
                    </label>
                    <label>
                      <span>Name</span>
                      <input
                        className="aya-modal-input"
                        value={row.name}
                        onChange={(e) =>
                          updateRow(row.__key, { name: e.target.value })
                        }
                        placeholder="Display name"
                      />
                    </label>
                    {isAgent && (
                      <label>
                        <span>Config directory</span>
                        <input
                          className="aya-modal-input"
                          value={row.configDir ?? ""}
                          onChange={(e) =>
                            updateAgentFields(row.__key, {
                              configDir: e.target.value,
                            })
                          }
                          placeholder={
                            row.agent === "claude"
                              ? DEFAULT_CLAUDE_CONFIG_DIR
                              : DEFAULT_CODEX_CONFIG_DIR
                          }
                          spellCheck={false}
                        />
                      </label>
                    )}
                  </div>
                </div>

                <div className="aya-preset-section">
                  <div className="aya-settings-section-title">Appearance</div>
                  <div className="aya-preset-grid aya-preset-grid--appearance">
                    <label>
                      <span>Icon</span>
                      <input
                        className="aya-modal-input aya-settings-icon-input"
                        value={row.icon}
                        maxLength={3}
                        onChange={(e) =>
                          updateRow(row.__key, { icon: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>Icon color</span>
                      <input
                        className="aya-modal-input"
                        value={row.color}
                        onChange={(e) =>
                          updateRow(row.__key, { color: e.target.value })
                        }
                        placeholder={CLAUDE_BRAND_COLOR}
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <span>Theme</span>
                      <select
                        className="aya-modal-input"
                        value={row.themeId ?? ""}
                        onChange={(e) =>
                          updateRow(row.__key, {
                            themeId: e.target.value || undefined,
                          })
                        }
                      >
                        <option value="">Default</option>
                        {themes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

                <div className="aya-preset-section">
                  <div className="aya-settings-section-title">Behavior</div>
                  <div className="aya-preset-toggle-row">
                    <label className="aya-preset-toggle">
                      <span>
                        <strong>Auto-resume restored tabs</strong>
                        <small>
                          Adds the agent's resume argument after Aya restarts a PTY.
                        </small>
                      </span>
                      <input
                        type="checkbox"
                        checked={!!row.autoResume}
                        onChange={(e) =>
                          updateRow(row.__key, { autoResume: e.target.checked })
                        }
                      />
                    </label>
                    {isAgent && (
                      <label className="aya-preset-toggle">
                        <span>
                          <strong>Unsafe approvals</strong>
                          <small>Adds the agent's unsafe approval flag.</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={!!row.unsafeMode}
                          onChange={(e) =>
                            updateAgentFields(row.__key, {
                              unsafeMode: e.target.checked,
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                </div>

                <div className="aya-preset-remove-row">
                  <button
                    type="button"
                    className="aya-settings-add aya-preset-remove-btn"
                    onClick={() => removeRow(row.__key)}
                  >
                    Remove this preset
                  </button>
                </div>
              </div>
              );
            })()}

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
                    <span>Add {h.name}</span>
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
              </section>
            )}

            {activeTab === "snippets" && (
              <section className="aya-settings-pane">
                <SettingsHeader icon="bolt" title="Snippets">
                  Reusable terminal text stored editor-side.
                </SettingsHeader>

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
              <SettingsIcon name="add" />
              Add snippet
            </button>
          </div>
                </div>
              </section>
            )}
          </div>
        </div>

        <div className="aya-modal-actions aya-settings-actions">
          {activeTab === "presets" ? (
            <button className="aya-modal-btn" onClick={resetPresetsToDefaults}>
              Reset presets to defaults
            </button>
          ) : (
            <div />
          )}
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
