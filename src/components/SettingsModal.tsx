import { useEffect, useRef, useState } from "react";
import {
  type AyaIntelligenceConfig,
  type HarnessDef,
  type LayoutMode,
  type Preset,
  type Snippet,
  type Theme,
  type OmarchyStatus,
} from "../types";
import type { SettingsTab } from "../settings-tabs";
import { MachinesSettings } from "./MachinesSettings";
import { DiagnosticsTab } from "./settings/DiagnosticsTab";
import { UpdatesTab } from "./settings/UpdatesTab";
import { SettingsHeader, SettingsIcon } from "./settings/parts";
import { GeneralTab } from "./settings/GeneralTab";
import { useAgentHooks } from "./settings/useAgentHooks";
import { useSettingsDrafts } from "./settings/useSettingsDrafts";
import { IntelligenceTab } from "./settings/IntelligenceTab";
import { PresetsTab } from "./settings/PresetsTab";
import { SnippetsTab } from "./settings/SnippetsTab";
import { ThemesTab } from "./settings/ThemesTab";
import type { MacOptionKeyMode } from "../terminal-option-key";
import type { TerminalSoundCue } from "../terminal-sound-prefs";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";
import { StatusConsentDialog, UsageConsentDialog } from "./settings/HookConsentDialogs";

interface Props {
  presets: Preset[];
  defaults: Preset[];
  snippets: Snippet[];
  themes: Theme[];
  activeThemeId: string;
  appThemePreference: "system" | "light" | "dark" | "omarchy" | "violet";
  onAppThemePreferenceChange: (
    theme: "system" | "light" | "dark" | "omarchy" | "violet",
  ) => void;
  terminalFontFamily: string;
  onTerminalFontFamilyChange: (fontFamily: string) => void;
  showUsageHarnessName: boolean;
  onShowUsageHarnessNameChange: (show: boolean) => void;
  showGitHubLink: boolean;
  onShowGitHubLinkChange: (show: boolean) => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
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
  const {draft, activePresetKey, setActivePresetKey, snippetDraft, themes, activeThemeId, themesDirty, presetsDirty, snippetsDirty, snippetsSaveError, importError, saving, errors, updateRow, updateAgentFields, removeRow, addRow, addClaudeAccount, addSuggestion, addCodexAccount, updateSnippetRow, removeSnippetRow, addSnippetRow, resetPresetsToDefaults, setActiveTheme, deleteTheme, importTheme, handleSave} = useSettingsDrafts({ presets, defaults, snippets, initialThemes, initialActiveThemeId, onSave, onSaveSnippets, onSaveThemes, onImportTheme, onClose, setActiveTab });
  const { usageHook, usageHookBusy, enableUsageHook, disableUsageHook, statusHook, statusHookBusy, enableStatusHook, disableStatusHook } = useAgentHooks();
  const [showUsageConsent, setShowUsageConsent] = useState(false);
  const [showStatusConsent, setShowStatusConsent] = useState(false);
  const [omarchy, setOmarchy] = useState<OmarchyStatus | null>(null);
  const [localSummaryStatus, setLocalSummaryStatus] = useState<
    "checking" | "available" | "unavailable" | null
  >(null);
  // Aya Web (experimental): status is main-process state (web.json + the
  // running server), loaded on open and refreshed after every change.
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
    // On mount AND on theme change: `omarchy-theme-set` can run with Settings
    // open, leaving a mount-only read naming the previous theme.
    const refreshOmarchy = () => {
      void window.aya.omarchyStatus().then((status) => {
        if (!cancelled) setOmarchy(status);
      });
    };
    refreshOmarchy();
    const stopOmarchyWatch = window.aya.onOmarchyThemeChange(refreshOmarchy);
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

  const confirmUsageHook = () => {
    closeConsent(() => setShowUsageConsent(false));
    void enableUsageHook();
  };
  const confirmStatusHook = () => {
    closeConsent(() => setShowStatusConsent(false));
    void enableStatusHook();
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
        {showUsageConsent && <UsageConsentDialog onClose={() => closeConsent(() => setShowUsageConsent(false))} onConfirm={confirmUsageHook} />}
        {showStatusConsent && <StatusConsentDialog onClose={() => closeConsent(() => setShowStatusConsent(false))} onConfirm={confirmStatusHook} />}
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
                showUsageHarnessName={showUsageHarnessName}
                onShowUsageHarnessNameChange={onShowUsageHarnessNameChange}
                showGitHubLink={showGitHubLink}
                onShowGitHubLinkChange={onShowGitHubLinkChange}
                layoutMode={layoutMode}
                onLayoutModeChange={onLayoutModeChange}
                harnessSearchEnabled={harnessSearchEnabled}
                onHarnessSearchEnabledChange={onHarnessSearchEnabledChange}
                usageHook={usageHook}
                disableUsageHook={disableUsageHook}
                consentOpenerRef={consentOpenerRef}
                setShowUsageConsent={setShowUsageConsent}
                usageHookBusy={usageHookBusy}
                statusHook={statusHook}
                disableStatusHook={disableStatusHook}
                setShowStatusConsent={setShowStatusConsent}
                statusHookBusy={statusHookBusy}
                terminalSoundsEnabled={terminalSoundsEnabled}
                onTerminalSoundsEnabledChange={onTerminalSoundsEnabledChange}
                customWaitingSound={customWaitingSound}
                customDoneSound={customDoneSound}
                onCustomSoundChange={onCustomSoundChange}
                presets={presets}
                terminalSoundOverrides={terminalSoundOverrides}
                onTerminalSoundOverridesChange={onTerminalSoundOverridesChange}
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
