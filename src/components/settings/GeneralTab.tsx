import { type Dispatch, type SetStateAction, type RefObject } from "react";
import { PRESET_ID_SHELL } from "../../preset-ids";
import { type CliStatus, type ChromeStyle, type LayoutMode, type MicPermissionStatus, type Preset, type UsageHookStatus, type StatusHookStatus, type OmarchyStatus, type WebConfigureRequest, type WebServerStatus } from "../../types";
import { type MacOptionKeyMode } from "../../terminal-option-key";
import { type TerminalSoundCue } from "../../terminal-sound-prefs";
import { allNetworksWarning, WEB_LOOPBACK_HOST, webHostOptions } from "../../web-host-options";
import { SettingsHeader, SettingsRow } from "./parts";

interface GeneralTabProps {
  omarchy: OmarchyStatus | null;
  appThemePreference: "system" | "light" | "dark" | "omarchy";
  onAppThemePreferenceChange: (theme: "system" | "light" | "dark" | "omarchy") => void;
  terminalFontFamily: string;
  onTerminalFontFamilyChange: (fontFamily: string) => void;
  macOptionKeyMode: MacOptionKeyMode;
  onMacOptionKeyModeChange: (mode: MacOptionKeyMode) => void;
  isWeb: boolean;
  installCli: () => Promise<void>;
  cliInstalling: boolean;
  cliStatus: CliStatus | null;
  showUsageHarnessName: boolean;
  onShowUsageHarnessNameChange: (show: boolean) => void;
  showGitHubLink: boolean;
  onShowGitHubLinkChange: (show: boolean) => void;
  ghAvailable: boolean | null;
  layoutMode: LayoutMode;
  chromeStyle: ChromeStyle;
  onLayoutModeChange: (mode: LayoutMode) => void;
  onChromeStyleChange: (style: ChromeStyle) => void;
  harnessSearchEnabled: boolean;
  onHarnessSearchEnabledChange: (enabled: boolean) => void;
  ayaWeb: WebServerStatus | null;
  ayaWebBusy: boolean;
  applyAyaWeb: (req: WebConfigureRequest) => Promise<void>;
  ayaWebError: string | null;
  regenerateAyaWebPassword: () => Promise<void>;
  ayaWebPortDraft: string;
  setAyaWebPortDraft: Dispatch<SetStateAction<string>>;
  ayaWebUserDraft: string;
  setAyaWebUserDraft: Dispatch<SetStateAction<string>>;
  ayaWebPasswordDraft: string;
  setAyaWebPasswordDraft: Dispatch<SetStateAction<string>>;
  usageHook: UsageHookStatus | null;
  disableUsageHook: () => Promise<void>;
  consentOpenerRef: RefObject<HTMLElement | null>;
  setShowUsageConsent: Dispatch<SetStateAction<boolean>>;
  usageHookBusy: boolean;
  statusHook: StatusHookStatus | null;
  disableStatusHook: () => Promise<void>;
  setShowStatusConsent: Dispatch<SetStateAction<boolean>>;
  statusHookBusy: boolean;
  refreshNotificationPermission: () => Promise<void>;
  notificationPermission: NotificationPermission;
  terminalSoundsEnabled: boolean;
  onTerminalSoundsEnabledChange: (enabled: boolean) => void;
  customWaitingSound: string | null;
  customDoneSound: string | null;
  onCustomSoundChange: (cue: TerminalSoundCue, path: string | null) => void;
  presets: Preset[];
  terminalSoundOverrides: Record<string, boolean>;
  onTerminalSoundOverridesChange: (overrides: Record<string, boolean>) => void;
  micStatus: MicPermissionStatus | null;
  handleMicAction: () => Promise<void>;
  micBusy: boolean;
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
  installCli,
  cliInstalling,
  cliStatus,
  showUsageHarnessName,
  onShowUsageHarnessNameChange,
  showGitHubLink,
  onShowGitHubLinkChange,
  ghAvailable,
  layoutMode,
  chromeStyle,
  onLayoutModeChange,
  onChromeStyleChange,
  harnessSearchEnabled,
  onHarnessSearchEnabledChange,
  ayaWeb,
  ayaWebBusy,
  applyAyaWeb,
  ayaWebError,
  regenerateAyaWebPassword,
  ayaWebPortDraft,
  setAyaWebPortDraft,
  ayaWebUserDraft,
  setAyaWebUserDraft,
  ayaWebPasswordDraft,
  setAyaWebPasswordDraft,
  usageHook,
  disableUsageHook,
  consentOpenerRef,
  setShowUsageConsent,
  usageHookBusy,
  statusHook,
  disableStatusHook,
  setShowStatusConsent,
  statusHookBusy,
  refreshNotificationPermission,
  notificationPermission,
  terminalSoundsEnabled,
  onTerminalSoundsEnabledChange,
  customWaitingSound,
  customDoneSound,
  onCustomSoundChange,
  presets,
  terminalSoundOverrides,
  onTerminalSoundOverridesChange,
  micStatus,
  handleMicAction,
  micBusy,
}: GeneralTabProps) {
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
              : "Omarchy"}
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
    <SettingsRow
    icon="terminal"
    title="aya command-line tool"
    control={isWeb ? (
    <span className="aya-modal-hint">Available in the desktop app.</span>
    ) : (
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
        ["classic", "classic", "Projects on top"],
        ["projects-left", "classic", "Projects on left"],
        ["classic", "command-rail", "Command Rail"],
        ["projects-left", "command-rail", "Command Rail, projects left"],
      ] as const).map(([mode, style, label]) => (
        <button
          key={label}
          type="button"
          className={`aya-settings-segment ${
            layoutMode === mode && chromeStyle === style
              ? "aya-settings-segment--active"
              : ""
          }`}
          onClick={() => {
            onLayoutModeChange(mode);
            onChromeStyleChange(style);
          }}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    "Projects on top" keeps project tabs on top with the terminal list
    on the left. "Projects on left" moves projects into a left rail and
    puts terminal tabs along the top; split panes are disabled there.
    The two Command Rail options are the same two arrangements in a
    denser look: a rail of project avatars, flat rows with a marker on
    the selected terminal, and amber or red pane headers when an agent
    is waiting or failed. Colors follow your theme.
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
    <SettingsRow
    icon="captive_portal"
    title={
    <>
      Aya Web{" "}
      <span className="aya-settings-experimental">Experimental</span>
    </>
    }
    control={isWeb ? (
    <span className="aya-modal-hint">Available in the desktop app.</span>
    ) : (
    <div className="aya-settings-segmented" aria-label="Aya Web">
      {([
        [true, "On"],
        [false, "Off"],
      ] as const).map(([enabled, label]) => (
        <button
          key={String(enabled)}
          type="button"
          className={`aya-settings-segment ${
            (ayaWeb?.enabled ?? false) === enabled
              ? "aya-settings-segment--active"
              : ""
          }`}
          disabled={ayaWebBusy || !ayaWeb}
          onClick={() => void applyAyaWeb({ enabled })}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    {isWeb ? (
    "Aya Web server settings can only be changed from the desktop app."
    ) : (
    <>Use Aya from a browser, behind a user and password. Signing in
      gives full shell access to this machine. A new setup listens on
      this computer only: from another one, use an SSH tunnel, or choose
      a network below. There is no TLS, so on a network the password and
      your terminals travel unencrypted; choose only one you trust
      (Tailscale, WireGuard or your own LAN).</>
    )}
    {(ayaWebError ?? ayaWeb?.error) && (
    <div style={{ color: "#f85149", marginTop: 6 }}>
      {ayaWebError ?? ayaWeb?.error}
    </div>
    )}
    {ayaWeb && !isWeb && (
    <label
      style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}
    >
      Listen on
      <select
        className="aya-modal-input"
        aria-label="Aya Web listen address"
        value={ayaWeb.host}
        disabled={ayaWebBusy}
        onChange={(e) => void applyAyaWeb({ host: e.target.value })}
      >
        {webHostOptions(ayaWeb).map(([host, label]) => (
          <option key={host} value={host}>
            {label}
          </option>
        ))}
      </select>
    </label>
    )}
    {/* role=status: read out when it appears after a change, not on every open of Settings. */}
    {ayaWeb && !isWeb && allNetworksWarning(ayaWeb) && (
    <div role="status" style={{ marginTop: 6 }}>
      <strong>Warning:</strong> {allNetworksWarning(ayaWeb)}{" "}
      <button
        className="aya-modal-btn"
        type="button"
        disabled={ayaWebBusy}
        onClick={() => void applyAyaWeb({ host: WEB_LOOPBACK_HOST })}
      >
        This computer only
      </button>
    </div>
    )}
    {isWeb ? (
    <div className="aya-modal-hint" role="status">
      Aya Web server settings are available in the desktop app.
    </div>
    ) : ayaWeb?.enabled && (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: 8,
      }}
    >
      <div>
        {ayaWeb.running ? (
          <>
            Running at{" "}
            {ayaWeb.urls.map((url, i) => (
              <span key={url}>
                {i > 0 && ", "}
                <a
                  href={url}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.aya.openUrl(url);
                  }}
                >
                  {url}
                </a>
              </span>
            ))}
            {" — "}
            {ayaWeb.clients} client{ayaWeb.clients === 1 ? "" : "s"}{" "}
            connected.
          </>
        ) : (
          "Enabled but not running."
        )}
      </div>
      <div>
        Sign in as <code>{ayaWeb.user}</code> with{" "}
        {ayaWeb.generatedPassword ? (
          <>
            password <code>{ayaWeb.generatedPassword}</code>
          </>
        ) : (
          "your custom password"
        )}
        {"  "}
        <button
          className="aya-modal-btn"
          type="button"
          disabled={ayaWebBusy}
          onClick={() => void regenerateAyaWebPassword()}
          style={{ marginLeft: 8 }}
        >
          Regenerate password
        </button>
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          className="aya-modal-input"
          style={{ width: 70 }}
          aria-label="Aya Web port"
          value={ayaWebPortDraft}
          onChange={(e) => setAyaWebPortDraft(e.target.value)}
          placeholder="Port"
        />
        <input
          className="aya-modal-input"
          style={{ width: 120 }}
          aria-label="Aya Web user"
          value={ayaWebUserDraft}
          onChange={(e) => setAyaWebUserDraft(e.target.value)}
          placeholder="User"
        />
        <input
          className="aya-modal-input"
          style={{ width: 160 }}
          aria-label="Aya Web custom password"
          type="password"
          value={ayaWebPasswordDraft}
          onChange={(e) => setAyaWebPasswordDraft(e.target.value)}
          placeholder="New password (optional)"
        />
        <button
          className="aya-modal-btn"
          type="button"
          disabled={ayaWebBusy}
          onClick={() =>
            void applyAyaWeb({
              port: Number(ayaWebPortDraft),
              user: ayaWebUserDraft,
              ...(ayaWebPasswordDraft
                ? { password: ayaWebPasswordDraft }
                : {}),
            })
          }
        >
          Apply
        </button>
      </div>
    </div>
    )}
    </SettingsRow>
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
    {micStatus && micStatus !== "unsupported" && (
    <SettingsRow
    icon="mic"
    title="Microphone"
    control={(
      isWeb ? (
        <span className="aya-modal-hint">Available in the desktop app.</span>
      ) : (
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
      )
    )}
    >
    Aya never records. Used only by terminal tools you run (e.g. a
    /voice plugin). macOS permission: {micStatus}
    </SettingsRow>
    )}
      </div>
    </section>
  );
}
