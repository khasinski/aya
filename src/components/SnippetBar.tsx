import type { Snippet } from "../types";

interface Props {
  snippets: Snippet[];
  open: boolean;
  onClose: () => void;
  /** Called with the snippet to send. The caller writes its text to the PTY
   *  (appending a carriage return for autoRun) and returns focus to the
   *  terminal. */
  onSend: (snippet: Snippet) => void;
  onOpenSettings: () => void;
}

function MaterialIcon({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={`material-symbols ${className ?? ""}`}
      style={{ fontFamily: "Material Symbols Outlined" }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

/** Slide-up drawer of saved snippets for the active terminal. Each row shows
 *  the snippet's full text (not just its label) so the user can verify what a
 *  prompt does before sending it. */
export function SnippetBar({
  snippets,
  open,
  onClose,
  onSend,
  onOpenSettings,
}: Props) {
  return (
    <div
      className={`aya-snippetbar ${open ? "aya-snippetbar--open" : ""}`}
      // While closed the drawer is translated off-screen but still in the DOM.
      // `inert` removes its buttons from the tab order and the a11y tree (and
      // blocks pointer events) immediately on close — covering the window where
      // the CSS visibility transition is still animating.
      inert={!open}
      aria-hidden={!open}
    >
      <div className="aya-snippetbar-head">
        <MaterialIcon name="bolt" className="aya-snippetbar-head-icon" />
        <span>Snippets</span>
        <span className="aya-snippetbar-spacer" />
        <button
          className="aya-snippetbar-headbtn"
          type="button"
          title="Edit snippets in Settings"
          onClick={onOpenSettings}
        >
          <MaterialIcon name="settings" />
        </button>
        <button
          className="aya-snippetbar-headbtn"
          type="button"
          title="Close"
          // Keep terminal focus when closing the drawer (same as the toggle).
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
        >
          <MaterialIcon name="close" />
        </button>
      </div>

      {snippets.length === 0 ? (
        <div className="aya-snippetbar-empty">
          No snippets yet.{" "}
          <button
            type="button"
            className="aya-snippetbar-empty-link"
            onClick={onOpenSettings}
          >
            Add some in Settings
          </button>{" "}
          — saved text you can type into this terminal on demand.
        </div>
      ) : (
        <div className="aya-snippetbar-list">
          {snippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              className={`aya-snippet aya-snippet--${snippet.autoRun ? "run" : "hold"}`}
              onClick={() => onSend(snippet)}
              title={
                snippet.autoRun
                  ? "Type into terminal and run (Enter)"
                  : "Type into terminal without running"
              }
            >
              <span
                className={`aya-snippet-ico aya-snippet-ico--${
                  snippet.autoRun ? "run" : "hold"
                }`}
              >
                <MaterialIcon name={snippet.autoRun ? "play_arrow" : "pause"} />
              </span>
              <span className="aya-snippet-body">
                <span className="aya-snippet-name">
                  {snippet.name}
                  <span
                    className={`aya-snippet-tag aya-snippet-tag--${
                      snippet.autoRun ? "run" : "hold"
                    }`}
                  >
                    {snippet.autoRun ? "run" : "hold"}
                  </span>
                </span>
                <span className="aya-snippet-text">{snippet.text}</span>
              </span>
              <span className="aya-snippet-send">
                <MaterialIcon name={snippet.autoRun ? "play_arrow" : "keyboard"} />
                {snippet.autoRun ? "send" : "type"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
