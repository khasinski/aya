import { closeFromBackdropClick, markBackdropMouseDown } from "../modal-backdrop";

interface ConsentDialogProps {
  onClose: () => void;
  onConfirm: () => void;
}

export function UsageConsentDialog({ onClose, onConfirm }: ConsentDialogProps) {
  return (
    <div
      className="aya-modal-backdrop"
      style={{ zIndex: 10 }}
      onMouseDown={(e) => {
        e.stopPropagation();
        markBackdropMouseDown(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        closeFromBackdropClick(
          e,
          onClose,
        );
      }}
    >
      <div
        className="aya-modal aya-settings-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enable the usage chip?"
        tabIndex={-1}
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aya-modal-title">Enable the usage chip?</div>
        <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
          This writes a small script and sets it as your Claude Code{" "}
          <code>statusLine</code> in <code>~/.claude/settings.json</code>. Claude
          Code already reports your 5-hour and weekly limits to the status line;
          the script saves those two numbers locally for the chip.
          <br />
          <br />
          If you already have a status line, it keeps running and looks the
          same. No token is read and nothing is sent anywhere. Numbers refresh
          while a Claude Code session is open. You can turn it off here anytime
          (it restores your previous status line).
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button
            className="aya-modal-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={onConfirm}
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatusConsentDialog({ onClose, onConfirm }: ConsentDialogProps) {
  return (
    <div
      className="aya-modal-backdrop"
      style={{ zIndex: 10 }}
      onMouseDown={(e) => {
        e.stopPropagation();
        markBackdropMouseDown(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        closeFromBackdropClick(
          e,
          onClose,
        );
      }}
    >
      <div
        className="aya-modal aya-settings-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enable automatic status?"
        tabIndex={-1}
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aya-modal-title">Enable automatic status?</div>
        <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
          This writes a small script and Claude Code{" "}
          <code>Notification</code>, <code>PostToolUse</code> and{" "}
          <code>Stop</code> hooks into{" "}
          <code>~/.claude/settings.json</code>. Claude then reports its own
          turn state into the Aya pane it runs in: waiting for your input,
          running a tool, or done.
          <br />
          <br />
          For Codex it sets a <code>notify</code> program in{" "}
          <code>~/.codex/config.toml</code> so a finished turn shows{" "}
          <em>done</em>. If you already have your own Codex{" "}
          <code>notify</code>, Aya leaves it untouched.
          <br />
          <br />
          The hooks fire in every Claude Code / Codex session, but the
          script does nothing outside an Aya terminal. Aya sends nothing
          anywhere; it only sets the pane&apos;s status locally. You can
          turn it off here anytime (it removes both).
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button
            className="aya-modal-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={onConfirm}
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}
