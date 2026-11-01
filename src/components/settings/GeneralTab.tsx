import { useEffect, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import { PRESET_ID_SHELL } from "../../preset-ids";
import { type LayoutMode, type Preset, type UsageHookStatus, type StatusHookStatus, type OmarchyStatus } from "../../types";
import { type MacOptionKeyMode } from "../../terminal-option-key";
import { type TerminalSoundCue } from "../../terminal-sound-prefs";
import { SettingsHeader, SettingsRow } from "./parts";
import { AyaWebRow } from "./AyaWebRow";
import { CliRow, MicrophoneRow, NotificationsRow } from "./SystemRows";

interface GeneralTabProps {
  omarchy: OmarchyStatus | null;
  appThemePreference: "system" | "light" | "dark" | "omarchy" | "violet";
  onAppThemePreferenceChange: (theme: "system" | "light" | "dark" | "omarchy" | "violet") => void;
  terminalFontFamily: string;
  onTerminalFontFamilyChange: (fontFamily: string) => void;
  macOptionKeyMode: MacOptionKeyMode;
  onMacOptionKeyModeChange: (mode: MacOptionKeyMode) => void;
  isWeb: boolean;
  showUsageHarnessName: boolean;
  onShowUsageHarnessNameChange: (show: boolean) => void;
  showGitHubLink: boolean;
  onShowGitHubLinkChange: (show: boolean) => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  harnessSearchEnabled: boolean;
  onHarnessSearchEnabledChange: (enabled: boolean) => void;
  usageHook: UsageHookStatus | null;
  disableUsageHook: () => Promise<void>;
  consentOpenerRef: RefObject<HTMLElement | null>;
  setShowUsageConsent: Dispatch<SetStateAction<boolean>>;
  usageHookBusy: boolean;
  statusHook: StatusHookStatus | null;
  disableStatusHook: () => Promise<void>;
  setShowStatusConsent: Dispatch<SetStateAction<boolean>>;
  statusHookBusy: boolean;
  terminalSoundsEnabled: boolean;
  onTerminalSoundsEnabledChange: (enabled: boolean) => void;
  customWaitingSound: string | null;
  customDoneSound: string | null;
  onCustomSoundChange: (cue: TerminalSoundCue, path: string | null) => void;
  presets: Preset[];
  terminalSoundOverrides: Record<string, boolean>;
  onTerminalSoundOverridesChange: (overrides: Record<string, boolean>) => void;
}

export function GeneralTab({
  omarchy,
  appThemePreference,
  onAppThemePreferenceChange,
  terminalFontFamily,
  onTerminalFontFamilyChange,
  macOptionKeyMode,
  onMacOptionKeyModeChange,
  isWeb,
  showUsageHarnessName,
  onShowUsageHarnessNameChange,
  showGitHubLink,
  onShowGitHubLinkChange,
  layoutMode,
  onLayoutModeChange,
  harnessSearchEnabled,
  onHarnessSearchEnabledChange,
  usageHook,
  disableUsageHook,
  consentOpenerRef,
  setShowUsageConsent,
  usageHookBusy,
  statusHook,
  disableStatusHook,
  setShowStatusConsent,
  statusHookBusy,
  terminalSoundsEnabled,
  onTerminalSoundsEnabledChange,
  customWaitingSound,
  customDoneSound,
  onCustomSoundChange,
  presets,
  terminalSoundOverrides,
  onTerminalSoundOverridesChange,
}: GeneralTabProps) {
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.aya.githubCliAvailable().then((available) => {
      if (!cancelled) setGhAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="aya-settings-pane">
      <SettingsHeader icon="tune" title="General" />
      <div className="aya-settings-general">
    <SettingsRow
    icon="contrast"
    title="Appearance"
    control={(
    <div className="aya-settings-segmented" aria-label="Appearance">
    {(
      [
        "system",
        "light",
        "dark",
        "violet",
        // Omarchy is OFFERED only when it is installed with an active
        // theme - but it is always RENDERED while it is the selected
        // value, so the control can never show four unselected
        // buttons (which is what it did on the first paint, before
        // the async status resolved, and whenever the preference
        // outlived the Omarchy install).
        ...(omarchy?.available || appThemePreference === "omarchy"
          ? (["omarchy"] as const)
          : []),
      ] as const
    ).map((theme) => (
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
            : theme === "dark"
              ? "Dark"
              : theme === "violet" ? "Violet" : "Omarchy"}
      </button>
    ))}
    </div>
    )}
    >
    {appThemePreference !== "omarchy"
    ? "Follow system appearance or pin Aya."
    : omarchy?.available
      ? `Following Omarchy${omarchy.themeName ? ` (${omarchy.themeName})` : ""} - chrome and terminal.`
      : omarchy === null
        ? // Status still loading. Asserting a skin here would repeat,
          // in the copy, the first-paint bug fixed for the buttons.
          "Checking for an active Omarchy theme."
        : // Selected but unusable: say so rather than claim a skin
          // that is not being applied (App falls back to system).
          "Omarchy is not available here - following system appearance."}
    </SettingsRow>
    <SettingsRow
    icon="text_fields"
    title="Terminal font"
    labelFor="aya-terminal-font-family"
    control={(
    <input
      id="aya-terminal-font-family"
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
    <CliRow isWeb={isWeb} />
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
    icon="merge"
    title="GitHub link in the status bar"
    control={(
    <div className="aya-settings-segmented" aria-label="GitHub link">
      {([
        [true, "Show"],
        [false, "Hide"],
      ] as const).map(([show, label]) => (
        <button
          key={String(show)}
          type="button"
          className={`aya-settings-segment ${
            showGitHubLink === show
              ? "aya-settings-segment--active"
              : ""
          }`}
          onClick={() => onShowGitHubLinkChange(show)}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    Show a link to the current branch's pull request next to the branch
    name, falling back to the branch page on GitHub.{" "}
    {ghAvailable === false
    ? "Requires the GitHub CLI (gh), which isn't installed."
    : "Requires the GitHub CLI (gh)."}
    </SettingsRow>
    <SettingsRow
    icon="view_sidebar"
    title={
    <>
      Window layout{" "}
      <span className="aya-settings-experimental">Experimental</span>
    </>
    }
    control={(
    <div className="aya-settings-segmented" aria-label="Window layout">
      {([
        ["classic", "Projects on top"],
        ["projects-left", "Projects on left"],
      ] as const).map(([mode, label]) => (
        <button
          key={mode}
          type="button"
          className={`aya-settings-segment ${
            layoutMode === mode ? "aya-settings-segment--active" : ""
          }`}
          onClick={() => onLayoutModeChange(mode)}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    Classic keeps project tabs on top with the terminal list on the
    left. "Projects on left" moves projects into a left rail and puts
    terminal tabs along the top. Split panes are disabled in this layout.
    </SettingsRow>
    <SettingsRow
    icon="manage_search"
    title={
    <>
      Harness-aware search{" "}
      <span className="aya-settings-experimental">Experimental</span>
    </>
    }
    control={(
    <div
      className="aya-settings-segmented"
      aria-label="Harness-aware search"
    >
      {([
        [true, "On"],
        [false, "Off"],
      ] as const).map(([enabled, label]) => (
        <button
          key={String(enabled)}
          type="button"
          className={`aya-settings-segment ${
            harnessSearchEnabled === enabled
              ? "aya-settings-segment--active"
              : ""
          }`}
          onClick={() => onHarnessSearchEnabledChange(enabled)}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    Adds a History mode to the find bar (Cmd+F) in Claude Code and
    Codex tabs: searches the session transcripts those agents already
    keep on disk for the tab's directory, so hits survive TUI redraws
    and restarts. Local files only; nothing is indexed or uploaded.
    </SettingsRow>
    <AyaWebRow isWeb={isWeb} />
    <SettingsRow
    icon="donut_large"
    title="Claude usage chip"
    control={isWeb ? (
    <span className="aya-modal-hint">Available in the desktop app.</span>
    ) : (
    <button
    className="aya-modal-btn"
    onClick={
      usageHook?.installed
        ? disableUsageHook
        : (event) => {
            consentOpenerRef.current = event.currentTarget;
            setShowUsageConsent(true);
          }
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
    : "Off. Shows Claude limits."}
    </SettingsRow>
    <SettingsRow
    icon="sensors"
    title="Automatic status"
    control={isWeb ? (
    <span className="aya-modal-hint">Available in the desktop app.</span>
    ) : (
    <button
    className="aya-modal-btn"
    onClick={
      statusHook?.installed
        ? disableStatusHook
        : (event) => {
            consentOpenerRef.current = event.currentTarget;
            setShowStatusConsent(true);
          }
    }
    disabled={statusHookBusy || !statusHook}
    >
    {statusHookBusy
      ? "Working..."
      : statusHook?.installed
        ? "Disable"
        : "Enable"}
    </button>
    )}
    >
    {statusHook?.installed
    ? statusHook.codex?.conflict
      ? "On for Claude Code (waiting / active / done). Codex has its own notify, left untouched."
      : "On. Claude Code and Codex report their turn state into each pane."
    : "Off. Claude Code + Codex report each pane's status automatically."}
    </SettingsRow>
    <NotificationsRow />
    <SettingsRow
    icon="volume_up"
    title="Terminal sounds"
    control={(
    <div className="aya-settings-segmented" aria-label="Terminal sounds">
      {([
        [true, "On"],
        [false, "Off"],
      ] as const).map(([on, label]) => (
        <button
          key={String(on)}
          type="button"
          className={`aya-settings-segment ${
            terminalSoundsEnabled === on
              ? "aya-settings-segment--active"
              : ""
          }`}
          onClick={() => onTerminalSoundsEnabledChange(on)}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    Play a short chime when a terminal starts waiting for you, and
    another when one finishes in the background.
    {terminalSoundsEnabled && (
    <div className="aya-sound-settings">
      <div className="aya-sound-files">
        {([
          ["waiting", "Waiting", customWaitingSound],
          ["done", "Finished", customDoneSound],
        ] as const).map(([cue, label, current]) => (
          <div className="aya-sound-file" key={cue}>
            <span className="aya-sound-file-label">{label}</span>
            <span className="aya-sound-file-name" title={current ?? ""}>
              {current ? current.split("/").pop() : "Built-in chime"}
            </span>
            <button
              type="button"
              className="aya-modal-btn aya-modal-btn--slim"
              onClick={async () => {
                const picked = await window.aya.pickSoundFile();
                if (picked) onCustomSoundChange(cue, picked);
              }}
            >
              Choose…
            </button>
            {current && (
              <button
                type="button"
                className="aya-modal-btn aya-modal-btn--slim"
                onClick={() => onCustomSoundChange(cue, null)}
              >
                Reset
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="aya-sound-presets">
        <span className="aya-sound-presets-label">
          Play for these presets
        </span>
        {presets
          .filter((preset) => preset.id !== PRESET_ID_SHELL)
          .map((preset) => (
            <label className="aya-sound-preset" key={preset.id}>
              <input
                type="checkbox"
                checked={terminalSoundOverrides[preset.id] ?? true}
                onChange={(event) =>
                  onTerminalSoundOverridesChange({
                    ...terminalSoundOverrides,
                    [preset.id]: event.target.checked,
                  })
                }
              />
              <span>{preset.name}</span>
            </label>
          ))}
      </div>
    </div>
    )}
    </SettingsRow>
    <MicrophoneRow isWeb={isWeb} />
      </div>
    </section>
  );
}
