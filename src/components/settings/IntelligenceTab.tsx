import { OLLAMA_OPENAI_BASE_URL, RECOMMENDED_OLLAMA_MODEL } from "../../ollama-defaults";
import { type AyaIntelligenceConfig, type OllamaStatus } from "../../types";
import { SettingsHeader, SettingsIcon } from "./parts";

interface IntelligenceTabProps {
  localSummariesEnabled: boolean;
  onLocalSummariesEnabledChange: (enabled: boolean) => void;
  ayaIntelligence: AyaIntelligenceConfig;
  patchAyaIntelligence: (patch: Partial<AyaIntelligenceConfig>) => void;
  localSummaryStatus: "checking" | "available" | "unavailable" | null;
  refreshOllamaStatus: () => Promise<void>;
  ollamaBusy: boolean;
  pullOllamaModel: () => Promise<void>;
  ollamaStatus: OllamaStatus | null;
  testAyaIntelligence: () => Promise<void>;
  intelligenceTestBusy: boolean;
  onRefreshSummaries: () => void;
  intelligenceTestResult: string | null;
  autoSummaryStatus: { terminalCount: number; terminalsWithLines: number; totalLines: number; lastEvent: string; };
}

export function IntelligenceTab({
  localSummariesEnabled,
  onLocalSummariesEnabledChange,
  ayaIntelligence,
  patchAyaIntelligence,
  localSummaryStatus,
  refreshOllamaStatus,
  ollamaBusy,
  pullOllamaModel,
  ollamaStatus,
  testAyaIntelligence,
  intelligenceTestBusy,
  onRefreshSummaries,
  intelligenceTestResult,
  autoSummaryStatus,
}: IntelligenceTabProps) {
  return (
    <section className="aya-settings-pane">
      <SettingsHeader icon="auto_awesome" title="Intelligence">
        Experimental summaries for project tabs and terminal rows.
      </SettingsHeader>
      <div className="aya-intelligence-frame">
        <div className="aya-intelligence-head">
          <div className="aya-settings-row-icon">
            <SettingsIcon name="auto_awesome" />
          </div>
          <div>
            <div className="aya-settings-general-title">
              Aya Intelligence <span>Experimental</span>
            </div>
            <div className="aya-modal-hint">
              Short local or API-backed summaries for project tabs and
              terminal rows. Aya sends only recent terminal output.
            </div>
          </div>
        </div>
        <div className="aya-intelligence-grid">
          <div className="aya-intelligence-field">
            <label>Summaries</label>
            <div className="aya-settings-segmented" aria-label="Aya Intelligence">
              {([
                [true, "On"],
                [false, "Off"],
              ] as const).map(([enabled, label]) => (
                <button
                  key={String(enabled)}
                  type="button"
                  className={`aya-settings-segment ${
                    localSummariesEnabled === enabled
                      ? "aya-settings-segment--active"
                      : ""
                  }`}
                  onClick={() => onLocalSummariesEnabledChange(enabled)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="aya-intelligence-field">
            <label>Provider</label>
            <div className="aya-settings-segmented" aria-label="Aya Intelligence provider">
              {([
                ["apple", "Apple"],
                ["ollama", "Ollama"],
                ["openai", "OpenAI-like"],
              ] as const).map(([provider, label]) => (
                <button
                  key={provider}
                  type="button"
                  disabled={provider === "apple" && window.aya.platform !== "darwin"}
                  className={`aya-settings-segment ${
                    ayaIntelligence.provider === provider
                      ? "aya-settings-segment--active"
                      : ""
                  }`}
                  onClick={() => patchAyaIntelligence({ provider })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {ayaIntelligence.provider === "apple" && (
          <div className="aya-intelligence-status">
            {window.aya.platform !== "darwin"
              ? "Apple Intelligence is only available on macOS."
              : localSummaryStatus === "checking"
                ? "Checking Apple Intelligence availability."
                : localSummaryStatus === "unavailable"
                  ? "Apple Intelligence model unavailable on this Mac."
                  : "Apple Intelligence is selected."}
          </div>
        )}
        {ayaIntelligence.provider === "ollama" && (
          <div className="aya-intelligence-provider">
            <div className="aya-intelligence-field">
              <label>Ollama model</label>
              <input
                className="aya-modal-input"
                value={ayaIntelligence.ollamaModel}
                onChange={(e) =>
                  patchAyaIntelligence({ ollamaModel: e.target.value })
                }
                placeholder={RECOMMENDED_OLLAMA_MODEL}
                spellCheck={false}
              />
            </div>
            <div className="aya-intelligence-actions">
              <button
                className="aya-modal-btn"
                onClick={refreshOllamaStatus}
                disabled={ollamaBusy}
              >
                {ollamaBusy ? "Working..." : "Refresh"}
              </button>
              {window.aya.isWeb ? (
                <span className="aya-modal-hint">Available in the desktop app.</span>
              ) : (
                <button
                  className="aya-modal-btn"
                  onClick={pullOllamaModel}
                  disabled={
                    ollamaBusy ||
                    !ollamaStatus?.installed ||
                    !ayaIntelligence.ollamaModel.trim()
                  }
                >
                  {ollamaBusy ? "Downloading..." : "Download model"}
                </button>
              )}
            </div>
            <div className="aya-intelligence-status">
              {!ollamaStatus
                ? "Checking Ollama."
                : !ollamaStatus.installed
                  ? "Ollama was not found on PATH."
                  : !ollamaStatus.running
                    ? "Ollama is installed, but its local API is not running."
                    : ollamaStatus.recommendedModelInstalled
                      ? `${ollamaStatus.recommendedModel} is installed.`
                      : `${ollamaStatus.recommendedModel} is not installed yet.`}
              {ollamaStatus?.message ? ` ${ollamaStatus.message}` : ""}
            </div>
          </div>
        )}
        {ayaIntelligence.provider === "openai" && (
          <div className="aya-intelligence-provider">
            <div className="aya-intelligence-field">
              <label>Base URL</label>
              <input
                className="aya-modal-input"
                value={ayaIntelligence.openAiBaseUrl}
                onChange={(e) =>
                  patchAyaIntelligence({ openAiBaseUrl: e.target.value })
                }
                placeholder={OLLAMA_OPENAI_BASE_URL}
                spellCheck={false}
              />
            </div>
            <div className="aya-intelligence-grid">
              <div className="aya-intelligence-field">
                <label>Model</label>
                <input
                  className="aya-modal-input"
                  value={ayaIntelligence.openAiModel}
                  onChange={(e) =>
                    patchAyaIntelligence({ openAiModel: e.target.value })
                  }
                  placeholder="gpt-4.1-mini"
                  spellCheck={false}
                />
              </div>
              <div className="aya-intelligence-field">
                <label>API key</label>
                <input
                  className="aya-modal-input"
                  type="password"
                  value={ayaIntelligence.openAiApiKey}
                  onChange={(e) =>
                    patchAyaIntelligence({ openAiApiKey: e.target.value })
                  }
                  placeholder="Optional for local servers"
                  spellCheck={false}
                />
              </div>
            </div>
          </div>
        )}
        <div className="aya-intelligence-actions">
          <button
            className="aya-modal-btn"
            onClick={testAyaIntelligence}
            disabled={intelligenceTestBusy || !localSummariesEnabled}
          >
            {intelligenceTestBusy ? "Testing..." : "Test summary"}
          </button>
          <button
            className="aya-modal-btn"
            onClick={onRefreshSummaries}
            disabled={!localSummariesEnabled}
          >
            Refresh summaries now
          </button>
        </div>
        {intelligenceTestResult && (
          <div className="aya-intelligence-status">
            {intelligenceTestResult}
          </div>
        )}
        <div className="aya-intelligence-status">
          Auto: {autoSummaryStatus.terminalCount} terminal
          {autoSummaryStatus.terminalCount === 1 ? "" : "s"},{" "}
          {autoSummaryStatus.terminalsWithLines} with output,{" "}
          {autoSummaryStatus.totalLines} collected lines. Last:{" "}
          {autoSummaryStatus.lastEvent}
        </div>
      </div>
    </section>
  );
}
