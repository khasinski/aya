import { type Snippet } from "../../types";
import { type DraftSnippet } from "./drafts";
import { SettingsHeader, SettingsIcon } from "./parts";

interface SnippetsTabProps {
  snippetDraft: DraftSnippet[];
  updateSnippetRow: (key: string, patch: Partial<Snippet>) => void;
  removeSnippetRow: (key: string) => void;
  addSnippetRow: () => void;
  snippetsSaveError: string | null;
}

export function SnippetsTab({
  snippetDraft,
  updateSnippetRow,
  removeSnippetRow,
  addSnippetRow,
  snippetsSaveError,
}: SnippetsTabProps) {
  return (
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
    {snippetsSaveError && (
    <div className="aya-settings-errors" data-testid="snippets-save-error">
    {snippetsSaveError}
    </div>
    )}
      </div>
    </section>
  );
}
