import { useEffect, useState } from "react";
import { type CliStatus, type MicPermissionStatus } from "../../types";
import { SettingsRow } from "./parts";

/** The aya command-line tool row; it owns the install status. */
export function CliRow({ isWeb }: { isWeb: boolean }) {
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [cliInstalling, setCliInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.aya.cliStatus().then((status) => {
      if (!cancelled) setCliStatus(status);
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

  return (
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
  );
}

/** macOS notification permission: request when undecided, deep-link to System Settings when denied. */
export function NotificationsRow() {
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    typeof Notification === "undefined" ? "default" : Notification.permission,
  );

  const refreshNotificationPermission = async () => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    } else if (Notification.permission === "denied") {
      await window.aya.openNotificationSettings();
    }
    setNotificationPermission(Notification.permission);
  };

  return (
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
  );
}

export function MicrophoneRow({ isWeb }: { isWeb: boolean }) {
  const [micStatus, setMicStatus] = useState<MicPermissionStatus | null>(null);
  const [micBusy, setMicBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.aya.micStatus().then((status) => {
      if (!cancelled) setMicStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (!micStatus || micStatus === "unsupported") return null;
  return (
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
  );
}
