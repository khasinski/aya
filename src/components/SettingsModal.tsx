import { inferAgent } from "../agentPreset";
import { uuid } from "../uuid";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../colors";
import { useEffect, useRef, useState } from "react";
import {
  type AyaIntelligenceConfig,
  type CliStatus,
  type HarnessDef,
  type ChromeStyle,
  type LayoutMode,
  type MicPermissionStatus,
  type Preset,
  type Snippet,
  type Theme,
  type UsageHookStatus,
  type StatusHookStatus,
  type OmarchyStatus,
  type WebConfigureRequest,
  type WebServerStatus,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import { MachinesSettings } from "./MachinesSettings";
import { DiagnosticsTab } from "./settings/DiagnosticsTab";
import { UpdatesTab } from "./settings/UpdatesTab";
import { SettingsHeader, SettingsIcon } from "./settings/parts";
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
} from "./settings/drafts";
import { GeneralTab } from "./settings/GeneralTab";
import { IntelligenceTab } from "./settings/IntelligenceTab";
import { PresetsTab } from "./settings/PresetsTab";
import { SnippetsTab } from "./settings/SnippetsTab";
import { ThemesTab } from "./settings/ThemesTab";
import type { MacOptionKeyMode } from "../terminal-option-key";
import type { TerminalSoundCue } from "../terminal-sound-prefs";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";
import { HOOK_THROTTLE_MINUTES } from "../main-mirrors";

interface Props {
  presets: Preset[];
  defaults: Preset[];
  snippets: Snippet[];
  themes: Theme[];
  activeThemeId: string;
  appThemePreference: "system" | "light" | "dark" | "omarchy";
  onAppThemePreferenceChange: (
    theme: "system" | "light" | "dark" | "omarchy",
  ) => void;
  terminalFontFamily: string;
  onTerminalFontFamilyChange: (fontFamily: string) => void;
  showUsageHarnessName: boolean;
  onShowUsageHarnessNameChange: (show: boolean) => void;
  showGitHubLink: boolean;
  onShowGitHubLinkChange: (show: boolean) => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  chromeStyle: ChromeStyle;
  onChromeStyleChange: (style: ChromeStyle) => void;
  harnessSearchEnabled: boolean;
  onHarnessSearchEnabledChange: (enabled: boolean) => void;
  terminalSoundsEnabled: boolean;
  onTerminalSoundsEnabledChange: (enabled: boolean) => void;
  terminalSoundOverrides: Record<string, boolean>;
  onTerminalSoundOverridesChange: (overrides: Record<string, boolean>) => void;
  customWaitingSound: string | null;
  customDoneSound: string | null;
  onCustomSoundChange: (cue: TerminalSoundCue, path: string | null) => void;
  localSummariesEnabled: boolean;
  onLocalSummariesEnabledChange: (enabled: boolean) => void;
  ayaIntelligence: AyaIntelligenceConfig;
  onAyaIntelligenceChange: (config: AyaIntelligenceConfig) => void;
  autoSummaryStatus: {
    terminalCount: number;
    terminalsWithLines: number;
    totalLines: number;
    lastEvent: string;
  };
  onRefreshSummaries: () => void;
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
   *  button confirms first. Resolves the reason when the restart did not finish, else null. */
  onRestartPtyHost: () => Promise<string | null> | void;
  initialTab?: SettingsTab;
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
  showGitHubLink,
  onShowGitHubLinkChange,
  layoutMode,
  onLayoutModeChange,
  chromeStyle,
  onChromeStyleChange,
  harnessSearchEnabled,
  onHarnessSearchEnabledChange,
  terminalSoundsEnabled,
  onTerminalSoundsEnabledChange,
  terminalSoundOverrides,
  onTerminalSoundOverridesChange,
  customWaitingSound,
  customDoneSound,
  onCustomSoundChange,
  localSummariesEnabled,
  onLocalSummariesEnabledChange,
  ayaIntelligence,
  onAyaIntelligenceChange,
  autoSummaryStatus,
  onRefreshSummaries,
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const consentOpenerRef = useRef<HTMLElement | null>(null);
  const isWeb = window.aya.isWeb === true;
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
  const [snippetsSaveError, setSnippetsSaveError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [usageHook, setUsageHook] = useState<UsageHookStatus | null>(null);
  const [usageHookBusy, setUsageHookBusy] = useState(false);
  const [showUsageConsent, setShowUsageConsent] = useState(false);
  const [statusHook, setStatusHook] = useState<StatusHookStatus | null>(null);
  const [statusHookBusy, setStatusHookBusy] = useState(false);
  const [showStatusConsent, setShowStatusConsent] = useState(false);
  const [omarchy, setOmarchy] = useState<OmarchyStatus | null>(null);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermission>(() =>
      typeof Notification === "undefined" ? "default" : Notification.permission,
    );
  const [micStatus, setMicStatus] = useState<MicPermissionStatus | null>(null);
  const [micBusy, setMicBusy] = useState(false);
  const [localSummaryStatus, setLocalSummaryStatus] = useState<
    "checking" | "available" | "unavailable" | null
  >(null);
  // Aya Web (experimental): status is main-process state (web.json + the
  // running server), loaded on open and refreshed after every change.
  const [ayaWeb, setAyaWeb] = useState<WebServerStatus | null>(null);
  const [ayaWebBusy, setAyaWebBusy] = useState(false);
  const [ayaWebError, setAyaWebError] = useState<string | null>(null);
  const [ayaWebPortDraft, setAyaWebPortDraft] = useState("");
  const [ayaWebUserDraft, setAyaWebUserDraft] = useState("");
  const [ayaWebPasswordDraft, setAyaWebPasswordDraft] = useState("");
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
    void window.aya.githubCliAvailable().then((available) => {
      if (!cancelled) setGhAvailable(available);
    });
    void window.aya.usageHookStatus().then((status) => {
      if (!cancelled) setUsageHook(status);
    });
    void window.aya.statusHookStatus().then((status) => {
      if (!cancelled) setStatusHook(status);
    });
    // On mount AND on theme change: `omarchy-theme-set` can run with Settings
    // open, leaving a mount-only read naming the previous theme.
    const refreshOmarchy = () => {
      void window.aya.omarchyStatus().then((status) => {
        if (!cancelled) setOmarchy(status);
      });
    };
    refreshOmarchy();
    const stopOmarchyWatch = window.aya.onOmarchyThemeChange(refreshOmarchy);
    void window.aya.micStatus().then((status) => {
      if (!cancelled) setMicStatus(status);
    });
    void window.aya
      .webStatus()
      .then((status) => {
        if (cancelled) return;
        setAyaWeb(status);
        setAyaWebPortDraft(String(status.port));
        setAyaWebUserDraft(status.user);
      })
      // A web.json Aya cannot read now (permissions) is reported, not replaced: say why the controls stay off.
      .catch((err: unknown) => {
        if (!cancelled) setAyaWebError(err instanceof Error ? err.message : String(err));
      });
    if (window.aya.platform === "darwin") {
      setLocalSummaryStatus("checking");
      void window.aya
        .summarizeLocal({
          kind: "terminal",
          lines: [
            "Aya local summaries status check",
            "Checking Apple Intelligence model availability",
            "No user terminal output is included",
          ],
        })
        .then((status) => {
          if (!cancelled) {
            setLocalSummaryStatus(status.available ? "available" : "unavailable");
          }
        })
        .catch(() => {
          if (!cancelled) setLocalSummaryStatus("unavailable");
        });
    }
    return () => {
      cancelled = true;
      stopOmarchyWatch();
    };
  }, []);

  const applyAyaWeb = async (req: WebConfigureRequest) => {
    setAyaWebBusy(true);
    setAyaWebError(null);
    try {
      const status = await window.aya.configureWeb(req);
      setAyaWeb(status);
      setAyaWebPortDraft(String(status.port));
      setAyaWebUserDraft(status.user);
      setAyaWebPasswordDraft("");
    } catch (err) {
      setAyaWebError(err instanceof Error ? err.message : String(err));
    } finally {
      setAyaWebBusy(false);
    }
  };

  const regenerateAyaWebPassword = async () => {
    setAyaWebBusy(true);
    setAyaWebError(null);
    try {
      setAyaWeb(await window.aya.regenerateWebPassword());
    } catch (err) {
      setAyaWebError(err instanceof Error ? err.message : String(err));
    } finally {
      setAyaWebBusy(false);
    }
  };

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
    closeConsent(() => setShowUsageConsent(false));
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

  // Automatic status (#38): enabling writes Claude Code Notification/PostToolUse/
  // Stop hooks + a script into ~/.claude (after consent); disabling removes both.
  // The generated script only reports into the current Aya pane and no-ops in any
  // Claude session run outside Aya.
  const enableStatusHook = async () => {
    closeConsent(() => setShowStatusConsent(false));
    setStatusHookBusy(true);
    try {
      setStatusHook(await window.aya.installStatusHook());
    } finally {
      setStatusHookBusy(false);
    }
  };

  const disableStatusHook = async () => {
    setStatusHookBusy(true);
    try {
      setStatusHook(await window.aya.uninstallStatusHook());
    } finally {
      setStatusHookBusy(false);
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

  const patchAyaIntelligence = (patch: Partial<AyaIntelligenceConfig>) => {
    if (patch.provider) onLocalSummariesEnabledChange(true);
    onAyaIntelligenceChange({ ...ayaIntelligence, ...patch });
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

  const closeConsent = (close: () => void) => {
    const opener = consentOpenerRef.current;
    close();
    window.requestAnimationFrame(() => {
      if (opener?.isConnected && !opener.hasAttribute("disabled")) {
        opener.focus();
      } else {
        dialogRef.current?.focus();
      }
      consentOpenerRef.current = null;
    });
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type=hidden])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const topmostDialog = () =>
      dialog.querySelector<HTMLElement>(".aya-settings-consent-dialog") ?? dialog;
    const focusable = () =>
      [...topmostDialog().querySelectorAll<HTMLElement>(focusableSelector)].filter(
        (element) => element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0,
      );
    (focusable()[0] ?? topmostDialog()).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (showUsageConsent) {
          closeConsent(() => setShowUsageConsent(false));
        } else if (showStatusConsent) {
          closeConsent(() => setShowStatusConsent(false));
        } else {
          onClose();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        e.preventDefault();
        topmostDialog().focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !topmostDialog().contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !topmostDialog().contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, showStatusConsent, showUsageConsent]);

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

  const tabItems: Array<{
    id: SettingsTab;
    label: string;
    icon: string;
    dirty: boolean;
  }> = [
    { id: "general", label: "General", icon: "tune", dirty: false },
    { id: "intelligence", label: "Intelligence", icon: "auto_awesome", dirty: false },
    { id: "updates", label: "Updates", icon: "system_update", dirty: false },
    { id: "diagnostics", label: "Diagnostics", icon: "monitor_heart", dirty: false },
    { id: "machines", label: "Machines", icon: "dns", dirty: false },
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
        ref={dialogRef}
        className="aya-modal aya-modal--settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
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
              closeFromBackdropClick(
                e,
                () => closeConsent(() => setShowUsageConsent(false)),
              );
            }}
          >
            <div
              className="aya-modal aya-settings-consent-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Enable the usage chip?"
              tabIndex={-1}
              style={{ maxWidth: 460 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="aya-modal-title">Enable the usage chip?</div>
              <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
                This writes a small script and a <code>Stop</code> hook into{" "}
                <code>~/.claude/settings.json</code>. After each Claude Code
                response (throttled to every {HOOK_THROTTLE_MINUTES}&nbsp;min) the hook queries
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
                  onClick={() => closeConsent(() => setShowUsageConsent(false))}
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
        {showStatusConsent && (
          <div
            className="aya-modal-backdrop"
            style={{ zIndex: 10 }}
            onMouseDown={(e) => {
              e.stopPropagation();
              markBackdropMouseDown(e);
            }}
            onClick={(e) => {
              e.stopPropagation();
              closeFromBackdropClick(
                e,
                () => closeConsent(() => setShowStatusConsent(false)),
              );
            }}
          >
            <div
              className="aya-modal aya-settings-consent-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Enable automatic status?"
              tabIndex={-1}
              style={{ maxWidth: 460 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="aya-modal-title">Enable automatic status?</div>
              <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
                This writes a small script and Claude Code{" "}
                <code>Notification</code>, <code>PostToolUse</code> and{" "}
                <code>Stop</code> hooks into{" "}
                <code>~/.claude/settings.json</code>. Claude then reports its own
                turn state into the Aya pane it runs in: waiting for your input,
                running a tool, or done.
                <br />
                <br />
                For Codex it sets a <code>notify</code> program in{" "}
                <code>~/.codex/config.toml</code> so a finished turn shows{" "}
                <em>done</em>. If you already have your own Codex{" "}
                <code>notify</code>, Aya leaves it untouched.
                <br />
                <br />
                The hooks fire in every Claude Code / Codex session, but the
                script does nothing outside an Aya terminal. Aya sends nothing
                anywhere; it only sets the pane&apos;s status locally. You can
                turn it off here anytime (it removes both).
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
                  onClick={() => closeConsent(() => setShowStatusConsent(false))}
                >
                  Cancel
                </button>
                <button
                  className="aya-modal-btn aya-modal-btn--primary"
                  onClick={enableStatusHook}
                >
                  Enable
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="aya-settings-chrome" inert={showUsageConsent || showStatusConsent}>
          <div className="aya-settings-toolbar" role="tablist" aria-label="Settings">
            {tabItems.map((item) => (
              <button
                key={item.id}
                data-testid="settings-tab"
                id={`settings-tab-${item.id}`}
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
              <ThemesTab
                themes={themes}
                activeThemeId={activeThemeId}
                setActiveTheme={setActiveTheme}
                deleteTheme={deleteTheme}
                importTheme={importTheme}
                importError={importError}
              />
            )}

            {activeTab === "general" && (
              <GeneralTab
                omarchy={omarchy}
                appThemePreference={appThemePreference}
                onAppThemePreferenceChange={onAppThemePreferenceChange}
                terminalFontFamily={terminalFontFamily}
                onTerminalFontFamilyChange={onTerminalFontFamilyChange}
                macOptionKeyMode={macOptionKeyMode}
                onMacOptionKeyModeChange={onMacOptionKeyModeChange}
                isWeb={isWeb}
                installCli={installCli}
                cliInstalling={cliInstalling}
                cliStatus={cliStatus}
                showUsageHarnessName={showUsageHarnessName}
                onShowUsageHarnessNameChange={onShowUsageHarnessNameChange}
                showGitHubLink={showGitHubLink}
                onShowGitHubLinkChange={onShowGitHubLinkChange}
                ghAvailable={ghAvailable}
                layoutMode={layoutMode}
                chromeStyle={chromeStyle}
                onLayoutModeChange={onLayoutModeChange}
                onChromeStyleChange={onChromeStyleChange}
                harnessSearchEnabled={harnessSearchEnabled}
                onHarnessSearchEnabledChange={onHarnessSearchEnabledChange}
                ayaWeb={ayaWeb}
                ayaWebBusy={ayaWebBusy}
                applyAyaWeb={applyAyaWeb}
                ayaWebError={ayaWebError}
                regenerateAyaWebPassword={regenerateAyaWebPassword}
                ayaWebPortDraft={ayaWebPortDraft}
                setAyaWebPortDraft={setAyaWebPortDraft}
                ayaWebUserDraft={ayaWebUserDraft}
                setAyaWebUserDraft={setAyaWebUserDraft}
                ayaWebPasswordDraft={ayaWebPasswordDraft}
                setAyaWebPasswordDraft={setAyaWebPasswordDraft}
                usageHook={usageHook}
                disableUsageHook={disableUsageHook}
                consentOpenerRef={consentOpenerRef}
                setShowUsageConsent={setShowUsageConsent}
                usageHookBusy={usageHookBusy}
                statusHook={statusHook}
                disableStatusHook={disableStatusHook}
                setShowStatusConsent={setShowStatusConsent}
                statusHookBusy={statusHookBusy}
                refreshNotificationPermission={refreshNotificationPermission}
                notificationPermission={notificationPermission}
                terminalSoundsEnabled={terminalSoundsEnabled}
                onTerminalSoundsEnabledChange={onTerminalSoundsEnabledChange}
                customWaitingSound={customWaitingSound}
                customDoneSound={customDoneSound}
                onCustomSoundChange={onCustomSoundChange}
                presets={presets}
                terminalSoundOverrides={terminalSoundOverrides}
                onTerminalSoundOverridesChange={onTerminalSoundOverridesChange}
                micStatus={micStatus}
                handleMicAction={handleMicAction}
                micBusy={micBusy}
              />
            )}

            {activeTab === "intelligence" && (
              <IntelligenceTab
                localSummariesEnabled={localSummariesEnabled}
                onLocalSummariesEnabledChange={onLocalSummariesEnabledChange}
                ayaIntelligence={ayaIntelligence}
                patchAyaIntelligence={patchAyaIntelligence}
                localSummaryStatus={localSummaryStatus}
                onRefreshSummaries={onRefreshSummaries}
                autoSummaryStatus={autoSummaryStatus}
              />
            )}

            {activeTab === "updates" && <UpdatesTab isWeb={isWeb} />}

            {activeTab === "machines" && (
              <section className="aya-settings-pane">
                <SettingsHeader icon="dns" title="Machines">
                  {isWeb
                    ? "Machine servers are configured from the desktop app."
                    : "Your model servers: Ollama or an OpenAI-compatible API. Their state shows in the status bar; Aya never loads or unloads a model."}
                </SettingsHeader>
                {isWeb ? (
                  <div className="aya-modal-hint">Machine settings are available in the desktop app.</div>
                ) : (
                  <MachinesSettings />
                )}
              </section>
            )}

            {activeTab === "diagnostics" && (
              <DiagnosticsTab isWeb={isWeb} onRestartPtyHost={onRestartPtyHost} />
            )}

            {activeTab === "presets" && (
              <PresetsTab
                addClaudeAccount={addClaudeAccount}
                addCodexAccount={addCodexAccount}
                addRow={addRow}
                draft={draft}
                activePreset={activePreset}
                setActivePresetKey={setActivePresetKey}
                updateRow={updateRow}
                updateAgentFields={updateAgentFields}
                themes={themes}
                removeRow={removeRow}
                suggested={suggested}
                addSuggestion={addSuggestion}
                errors={errors}
              />
            )}

            {activeTab === "snippets" && (
              <SnippetsTab
                snippetDraft={snippetDraft}
                updateSnippetRow={updateSnippetRow}
                removeSnippetRow={removeSnippetRow}
                addSnippetRow={addSnippetRow}
                snippetsSaveError={snippetsSaveError}
              />
            )}
          </div>
        </div>

        <div className="aya-modal-actions aya-settings-actions" inert={showUsageConsent || showStatusConsent}>
          {activeTab === "presets" ? (
            <button className="aya-modal-btn" onClick={resetPresetsToDefaults}>
              Reset presets to defaults
            </button>
          ) : activeTab === "machines" ? (
            <span className="aya-settings-actions-note">Machines are saved as you change them.</span>
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
