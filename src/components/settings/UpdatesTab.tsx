import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../types";
import { SettingsHeader, SettingsRow } from "./parts";

export function UpdatesTab({ isWeb }: { isWeb: boolean }) {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.aya.getUpdateStatus().then((status) => {
      if (!cancelled) setUpdateStatus(status);
    });
    const stop = window.aya.onUpdateStatus((status) => {
      setUpdateStatus(status);
      if (status.phase !== "checking") setUpdateBusy(false);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  const checkUpdates = async () => {
    setUpdateBusy(true);
    try {
      setUpdateStatus(await window.aya.checkForUpdates());
    } finally {
      setUpdateBusy(false);
    }
  };

  const installUpdate = async () => {
    await window.aya.installUpdate();
  };

  return (
    <section className="aya-settings-pane">
      <SettingsHeader icon="system_update" title="Updates">
        {isWeb
          ? "Check for updates here; install them from the desktop app."
          : "App version checks and restart-to-update controls."}
      </SettingsHeader>
      <div className="aya-settings-general">
        <SettingsRow
          icon="system_update"
          title="Updates"
          control={(
            <div className="aya-settings-button-row">
              <button
                className="aya-modal-btn"
                onClick={checkUpdates}
                disabled={
                  updateBusy ||
                  updateStatus?.phase === "checking" ||
                  updateStatus?.phase === "downloading" ||
                  updateStatus?.supported === false
                }
              >
                {updateBusy || updateStatus?.phase === "checking"
                  ? "Checking..."
                  : "Check"}
              </button>
              {isWeb ? (
                <span className="aya-modal-hint">Available in the desktop app.</span>
              ) : (
                <button
                  className="aya-modal-btn"
                  onClick={installUpdate}
                  disabled={updateStatus?.phase !== "downloaded"}
                >
                  Restart to update
                </button>
              )}
            </div>
          )}
        >
          {updateStatus?.phase === "downloaded"
            ? updateStatus.message
            : updateStatus?.phase === "downloading"
              ? `Downloading ${Math.round(updateStatus.percent ?? 0)}%.`
              : updateStatus?.message ??
                `Current version ${updateStatus?.currentVersion ?? ""}`.trim()}
        </SettingsRow>
        {updateStatus?.phase === "downloading" && (
          <div className="aya-settings-update-progress" aria-hidden="true">
            <span style={{ width: `${Math.round(updateStatus.percent ?? 0)}%` }} />
          </div>
        )}
        {/* A previous update that silently rolled back (#78). Shown
            separately from `message` because the phase/message pair
            is replaced by the next check - and this panel is usually
            opened long after that. */}
        {updateStatus?.rollbackNotice && (
          <p className="aya-settings-update-rollback" role="status">
            {updateStatus.rollbackNotice}
          </p>
        )}
      </div>
    </section>
  );
}
