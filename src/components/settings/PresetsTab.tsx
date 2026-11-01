import { type Dispatch, type SetStateAction } from "react";
import { agentBriefHint, guiSupportedAgent } from "../../agentPreset";
import { CLAUDE_BRAND_COLOR, CODEX_BRAND_COLOR } from "../../colors";
import { looksNonInteractive, type HarnessDef, type Preset, type Theme } from "../../types";
import { DEFAULT_CLAUDE_CONFIG_DIR, DEFAULT_CODEX_CONFIG_DIR, agentCommand, type DraftPreset } from "./drafts";
import { SettingsHeader, SettingsIcon } from "./parts";

interface PresetsTabProps {
  addClaudeAccount: () => void;
  addCodexAccount: () => void;
  addRow: () => void;
  draft: DraftPreset[];
  activePreset: DraftPreset;
  setActivePresetKey: Dispatch<SetStateAction<string | null>>;
  updateRow: (key: string, patch: Partial<Preset>) => void;
  updateAgentFields: (key: string, patch: Partial<Pick<Preset, "agent" | "configDir" | "unsafeMode">>) => void;
  themes: Theme[];
  removeRow: (key: string) => void;
  suggested: HarnessDef[];
  addSuggestion: (h: HarnessDef) => void;
  errors: string[];
}

export function PresetsTab({
  addClaudeAccount,
  addCodexAccount,
  addRow,
  draft,
  activePreset,
  setActivePresetKey,
  updateRow,
  updateAgentFields,
  themes,
  removeRow,
  suggested,
  addSuggestion,
  errors,
}: PresetsTabProps) {
  return (
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
    const guiAgent = guiSupportedAgent(row);
    const briefHint = agentBriefHint(row.agent);
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
            ⚠ Looks like Claude in non-interactive (print) mode: this
            pane will not be an interactive Claude session.
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
                } else if (agent === "pi") {
                  updateRow(row.__key, {
                    agent,
                    icon: row.icon || "π",
                    command: row.command || "pi",
                    autoResume: row.autoResume ?? true,
                  });
                } else if (agent === "antigravity") {
                  updateRow(row.__key, {
                    agent,
                    icon: row.icon || "✦",
                    command: row.command || "agy",
                    autoResume: row.autoResume ?? true,
                  });
                } else {
                  updateAgentFields(row.__key, { agent: "custom" });
                }
              }}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="pi">Pi</option>
              <option value="antigravity">Antigravity</option>
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
        <div className="aya-settings-section-title">Interface</div><div>
          <label><span>Conversation GUI · Experimental</span>
            <input type="checkbox" aria-label="Conversation GUI · Experimental" checked={row.interfaceMode === "gui"} disabled={!guiAgent} onChange={e => updateRow(row.__key, { interfaceMode: e.target.checked ? "gui" : "terminal" })} />
          </label>
          <p className="aya-settings-hint">Supports Codex, Claude Code, Pi and Antigravity. Uses each agent's structured local RPC/JSON stream protocol instead of a terminal emulator.</p>
        </div>
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
                Adds the agent's resume argument after Aya restarts a
                PTY. Agents that resume by session id do so once
                they've reported one.
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
          {briefHint && (
            <label className="aya-preset-toggle">
              <span>
                <strong>Tell the agent about aya</strong>
                <small>{briefHint}</small>
              </span>
              <input
                type="checkbox"
                checked={!!row.agentBrief}
                onChange={(e) =>
                  updateRow(row.__key, { agentBrief: e.target.checked })
                }
              />
            </label>
          )}
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
  );
}
