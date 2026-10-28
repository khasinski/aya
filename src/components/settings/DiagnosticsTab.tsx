import { useState } from "react";
import type { DiagnosticsReport } from "../../types";
import { SettingsHeader, SettingsRow } from "./parts";

export function DiagnosticsTab({
  isWeb,
  onRestartPtyHost,
}: {
  isWeb: boolean;
  onRestartPtyHost: () => Promise<string | null> | void;
}) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsReport | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  const diagnosticsJson = diagnostics
    ? JSON.stringify(diagnostics, null, 2)
    : "";

  const refreshDiagnostics = async () => {
    setDiagnosticsBusy(true);
    setDiagnosticsCopied(false);
    setDiagnosticsError(null);
    try {
      setDiagnostics(await window.aya.getDiagnostics());
    } catch (err) {
      setDiagnosticsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  // Aya asks before stopping them (in the main process, which Aya Web reaches too).
  const stopOtherHosts = async () => {
    try {
      await window.aya.stopOtherPtyHosts();
    } catch (err) {
      setDiagnosticsError(err instanceof Error ? err.message : String(err));
      return;
    }
    await refreshDiagnostics();
  };

  const copyDiagnostics = async () => {
    if (!diagnosticsJson) return;
    await window.aya.writeClipboard(diagnosticsJson);
    setDiagnosticsCopied(true);
  };

  return (
    <section className="aya-settings-pane">
      <SettingsHeader icon="monitor_heart" title="Diagnostics">
        Maintenance tools and a copyable support report.
      </SettingsHeader>
      <div className="aya-settings-general">
        <SettingsRow
          icon="restart_alt"
          title="PTY host"
          control={(
            isWeb ? (
              <span className="aya-modal-hint">Available in the desktop app.</span>
            ) : (
              <button
                className="aya-modal-btn"
                onClick={() => {
                  if (
                    confirm(
                      "Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.",
                    )
                  ) {
                    void Promise.resolve(onRestartPtyHost()).then(async (failure) => {
                      if (diagnostics || failure) await refreshDiagnostics();
                      if (failure) setDiagnosticsError(failure);
                    });
                  }
                }}
              >
                Restart
              </button>
            )
          )}
        >
          Restarts the background terminal host. Use after an update if
          terminals behave like an older version.
        </SettingsRow>
        <SettingsRow
          icon="monitor_heart"
          title="Diagnostics"
          control={(
            <div className="aya-settings-button-row">
              <button
                className="aya-modal-btn"
                onClick={refreshDiagnostics}
                disabled={diagnosticsBusy}
              >
                {diagnosticsBusy ? "Checking..." : "Refresh"}
              </button>
              <button
                className="aya-modal-btn"
                onClick={copyDiagnostics}
                disabled={!diagnosticsJson}
              >
                {diagnosticsCopied ? "Copied" : "Copy JSON"}
              </button>
            </div>
          )}
        >
          App, PTY host, sockets, presets, usage hook, and remote-ready state.
        </SettingsRow>
        {(diagnostics || diagnosticsError) && (
          <div className="aya-settings-diagnostics">
            {/* Above the report, not instead of it: after a failed restart the report says what still runs. */}
            {diagnosticsError && <div className="aya-settings-errors">{diagnosticsError}</div>}
            {diagnostics ? (
              <>
                {diagnostics.ptyHost.warnings.length > 0 && (
                  <div className="aya-settings-diagnostics-warnings" role="status">
                    {diagnostics.ptyHost.warnings.map((warning) => (
                      <div key={warning}>
                        <strong>Warning:</strong> {warning}
                      </div>
                    ))}
                    {diagnostics.ptyHost.otherHosts.length > 0 && (
                      isWeb ? (
                        <span className="aya-modal-hint">Available in the desktop app.</span>
                      ) : (
                        <button
                          className="aya-modal-btn"
                          type="button"
                          onClick={() => void stopOtherHosts()}
                        >
                          Stop other hosts
                        </button>
                      )
                    )}
                  </div>
                )}
                <div className="aya-settings-diagnostics-grid">
                  <div>
                    <span>Mode</span>
                    <strong>{diagnostics.app.mode}</strong>
                  </div>
                  <div>
                    <span>Version</span>
                    <strong>{diagnostics.app.version}</strong>
                  </div>
                  <div>
                    <span>PTYs</span>
                    <strong>{diagnostics.ptyHost.ptyCount}</strong>
                  </div>
                  <div>
                    <span>PTY host</span>
                    <strong>{diagnostics.ptyHost.stale ? "stale" : "current"}</strong>
                  </div>
                  <div>
                    <span>Presets</span>
                    <strong>{diagnostics.presets.length}</strong>
                  </div>
                  <div>
                    <span>Remote projects</span>
                    <strong>{diagnostics.projects.remote}</strong>
                  </div>
                </div>
                <section className="aya-settings-rule-diagnostics" aria-label="User screen rules">
                  <h3>User screen rules</h3>
                  <p>Files are in {diagnostics.userScreenRules.directory}.</p>
                  {diagnostics.userScreenRules.fileProblem ? (
                    <p>{/^(generic|claude|codex|opencode|grok|antigravity)\.json: /.test(diagnostics.userScreenRules.fileProblem)
                      ? diagnostics.userScreenRules.fileProblem
                      : `${diagnostics.userScreenRules.directory}: ${diagnostics.userScreenRules.fileProblem}`}. Aya continues to use built-in rules, so prompts are still detected.</p>
                  ) : diagnostics.userScreenRules.reason && !diagnostics.userScreenRules.available ? (
                    <p>Your rules are currently unavailable. Aya continues to use built-in rules, so prompts are still detected.</p>
                  ) : null}
                  <ul>
                    {diagnostics.userScreenRules.sets.filter((set) => set.status === "loaded").map((set) => (
                      <li key={set.agent}>
                        <strong>{({claude:"Claude",codex:"Codex",opencode:"OpenCode",grok:"Grok",antigravity:"Antigravity",generic:"Generic"} as const)[set.agent]}</strong>: built-in rules + {set.ruleCount ?? 0} of your rules ({(set.sources ?? []).map((source) => source.split("/").at(-1)).join(", ")})
                      </li>
                    ))}
                    {diagnostics.userScreenRules.available && !diagnostics.userScreenRules.sets.some((set) => set.status === "loaded") ? (
                      <li>All agents: built-in rules only</li>
                    ) : diagnostics.userScreenRules.available && diagnostics.userScreenRules.sets.some((set) => set.status === "built-in only") ? (
                      <li>Other agents: built-in rules only</li>
                    ) : null}
                  </ul>
                </section>
                <pre className="aya-settings-diagnostics-json">
                  {diagnosticsJson}
                </pre>
              </>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
